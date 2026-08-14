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
        payout_thresholds: { USD: 1000, EUR: 1000 },
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

test('verified pending accounts reconcile activation without an idempotency header', async () => {
  const payload = {
    version: '2026-07-29',
    correlationId: 'activation-reconcile-contract',
    data: {
      schema_version: 1,
      action: 'activation_reconciled',
      changed: true,
      account: {
        exists: true,
        status: 'active',
        verification_status: 'verified',
        contract_status: 'accepted',
        link_status: 'active',
      },
      next_action: 'share_link',
    },
  };
  const { cloud, requests } = loadCloudApi(payload);
  const controller = new AbortController();
  const result = await cloud.partners.activation.reconcile({
    signal: controller.signal,
  });

  assert.equal(result.data.action, 'activation_reconciled');
  assert.equal(result.data.changed, true);
  assert.equal(result.data.next_action, 'share_link');
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    'https://api.norva.tv/functions/v1/norva-partners/activation/reconcile',
  );
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].options.body), {});
  assert.equal(requests[0].options.signal instanceof AbortSignal, true);
  assert.equal(requests[0].options.signal.aborted, false);
  assert.equal(requests[0].options.headers['Idempotency-Key'], undefined);
  assert.equal(requests[0].options.headers['x-norva-profile-id'], undefined);
  assert.equal(Object.isFrozen(result.data.account), true);
});

test('activation reconcile fails closed on contradictory active state', async () => {
  const payload = {
    version: '2026-07-29',
    correlationId: 'activation-reconcile-invalid-contract',
    data: {
      schema_version: 1,
      action: 'activation_reconciled',
      changed: false,
      account: {
        exists: true,
        status: 'active',
        verification_status: 'verified',
        contract_status: 'accepted',
        link_status: 'active',
      },
      next_action: 'accept_terms',
    },
  };
  const { cloud } = loadCloudApi(payload);
  await assert.rejects(
    cloud.partners.activation.reconcile(),
    (error) => error?.code === 'partners_contract_invalid',
  );
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
    biometricConsentVersion: 'partners-biometric-consent-v1',
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
    biometricConsentVersion: 'partners-biometric-consent-v1',
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
      biometricConsentVersion: 'partners-biometric-consent-v1',
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
      biometricConsentVersion: 'partners-biometric-consent-v1',
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

test('Partners payout profile is masked, read-only and fail-closed', async () => {
  const getPayload = {
    version: '2026-07-29',
    correlationId: 'prt_0123456789abcdef01234567',
    data: {
      schema_version: 1,
      account: {
        id: `prt_${'a'.repeat(24)}`,
        status: 'active',
        country_code: 'FR',
      },
      fiscal: { status: 'verified', country_code: 'FR' },
      profile: {
        provider: 'revolut',
        display_masked: 'Revolut ·•• 8421',
        currency: 'EUR',
        status: 'active',
      },
      profiles: [{
        provider: 'revolut',
        display_masked: 'Revolut ·•• 8421',
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
  assert.equal(profile.data.profile.display_masked, 'Revolut ·•• 8421');
  assert.equal(JSON.stringify(profile).includes('beneficiaryTokenRef'), false);

  const cashPilotPayload = structuredClone(getPayload);
  cashPilotPayload.data.account.status = 'pending_verification';
  cashPilotPayload.data.account.country_code = null;
  cashPilotPayload.data.fiscal = null;
  cashPilotPayload.data.profile = null;
  cashPilotPayload.data.profiles = [];
  cashPilotPayload.data.readiness = {
    ready: false,
    payouts_live: false,
    reason: 'cash_pilot_not_allowed',
  };
  const cashPilot = loadCloudApi(cashPilotPayload);
  assert.equal(
    (await cashPilot.cloud.partners.payoutProfile()).data.readiness.reason,
    'cash_pilot_not_allowed',
  );
  const cashPilotDrift = structuredClone(cashPilotPayload);
  cashPilotDrift.data.readiness.reason = 'provider_not_configured';
  await assert.rejects(
    () => loadCloudApi(cashPilotDrift).cloud.partners.payoutProfile(),
    (error) => error?.code === 'partners_contract_invalid',
  );

  assert.equal(get.cloud.partners.saveTokenizedPayoutProfile, undefined);
});

test('Partners discloses Didit processor notices before hosted biometric capture', () => {
  const source = pageSource;
  assert.match(source, /Norva requests this eligibility check and Didit provides the secure hosted identity-verification flow/);
  assert.match(source, /https:\/\/didit\.me\/terms\/verification-privacy-notice\//);
  assert.match(source, /https:\/\/didit\.me\/terms\/identity-verification\//);
  assert.match(source, /explicitly consent to document, selfie, liveness and face-match capture/);
  assert.match(source, /data-partners-kyc-consent/);
});

test('Partners tax self-certification and Revolut manual setup expose no financial identifiers', async () => {
  const responder = (url, options) => {
    if (url.endsWith('/fiscal-profile') && options.method === 'GET') {
      return {
        version: '2026-07-29',
        correlationId: 'fiscal-loaded-contract',
        data: {
          schema_version: 1,
          action: 'fiscal_profile_loaded',
          fiscal_profile: {
            exists: false,
            status: 'missing',
            country_code: null,
            declaration_version: null,
            submitted_at: null,
            reviewed_at: null,
          },
        },
      };
    }
    if (url.endsWith('/fiscal-profile') && options.method === 'POST') {
      return {
        version: '2026-07-29',
        correlationId: 'fiscal-submitted-contract',
        data: {
          schema_version: 1,
          action: 'fiscal_profile_submitted',
          replayed: false,
          fiscal_profile: {
            exists: true,
            status: 'pending',
            country_code: 'FR',
            declaration_version: 'partners-tax-self-certification-v1',
            submitted_at: '2026-08-02T12:00:00Z',
            reviewed_at: null,
          },
        },
      };
    }
    if (url.endsWith('/payout-onboarding') && options.method === 'GET') {
      return {
        version: '2026-07-29',
        correlationId: 'payout-onboarding-loaded-contract',
        data: {
          schema_version: 1,
          action: 'payout_onboarding_loaded',
          payout_onboarding: {
            exists: false,
            status: 'not_started',
            currency: null,
            execution_adapter: 'revolut_manual',
            reconfiguration_required: false,
            requested_at: null,
            updated_at: null,
            reason_code: null,
          },
          allowed_currencies: ['EUR', 'USD'],
        },
      };
    }
    if (url.endsWith('/payout-onboarding') && options.method === 'POST') {
      return {
        version: '2026-07-29',
        correlationId: 'payout-onboarding-requested-contract',
        data: {
          schema_version: 1,
          action: 'payout_onboarding_requested',
          replayed: false,
          payout_onboarding: {
            exists: true,
            status: 'pending',
            currency: 'USD',
            execution_adapter: 'revolut_manual',
            reconfiguration_required: false,
            requested_at: '2026-08-02T12:05:00Z',
            updated_at: '2026-08-02T12:05:00Z',
            reason_code: null,
          },
        },
      };
    }
    throw new Error(`unexpected request ${url}`);
  };
  const { cloud, requests } = loadCloudApi(responder);
  const controller = new AbortController();
  const fiscal = await cloud.partners.fiscalProfile({ signal: controller.signal });
  const submitted = await cloud.partners.submitFiscalProfile({
    countryCode: 'fr',
    declarationAccepted: true,
    declarationVersion: 'partners-tax-self-certification-v1',
    idempotencyKey: 'fiscal:0123456789abcdef',
    taxId: 'must-not-leave-the-client',
  });
  const onboarding = await cloud.partners.payoutOnboarding({
    signal: controller.signal,
  });
  const requested = await cloud.partners.requestPayoutOnboarding({
    currency: 'usd',
    contactConsent: true,
    idempotencyKey: 'payout-onboarding:0123456789abcdef',
    iban: 'must-not-leave-the-client',
    beneficiaryTokenRef: 'must-not-leave-the-client',
  });

  assert.equal(fiscal.data.fiscal_profile.status, 'missing');
  assert.equal(submitted.data.fiscal_profile.status, 'pending');
  assert.deepEqual(clone(onboarding.data.allowed_currencies), ['EUR', 'USD']);
  assert.equal(requested.data.payout_onboarding.execution_adapter, 'revolut_manual');
  assert.equal(requests[0].options.signal, controller.signal);
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    countryCode: 'FR',
    declarationAccepted: true,
    declarationVersion: 'partners-tax-self-certification-v1',
  });
  assert.deepEqual(JSON.parse(requests[3].options.body), {
    currency: 'USD',
    contactConsent: true,
  });
  assert.equal(requests[1].options.headers['Idempotency-Key'], 'fiscal:0123456789abcdef');
  assert.equal(
    requests[3].options.headers['Idempotency-Key'],
    'payout-onboarding:0123456789abcdef',
  );
  assert.doesNotMatch(
    requests.map((request) => request.options.body || '').join(''),
    /iban|taxId|beneficiaryToken|revolut_manual/i,
  );
  assert.throws(
    () => cloud.partners.submitFiscalProfile({
      countryCode: 'FR',
      declarationAccepted: false,
      idempotencyKey: 'fiscal:fedcba9876543210',
    }),
    (error) => error?.code === 'partners_fiscal_declaration_invalid',
  );
  assert.throws(
    () => cloud.partners.requestPayoutOnboarding({
      currency: 'USD',
      contactConsent: false,
      idempotencyKey: 'payout-onboarding:fedcba9876543210',
    }),
    (error) => error?.code === 'partners_payout_onboarding_invalid',
  );
});

test('Partners Web accepts only the fail-closed legacy fiscal recovery shape', async () => {
  const envelope = {
    version: '2026-07-29',
    correlationId: 'fiscal-legacy-recovery-contract',
    data: {
      schema_version: 1,
      action: 'fiscal_profile_loaded',
      fiscal_profile: {
        exists: true,
        status: 'expired',
        country_code: 'FR',
        declaration_version: null,
        submitted_at: null,
        reviewed_at: '2026-08-02T12:00:00Z',
      },
    },
  };
  const recovery = loadCloudApi(envelope);
  const loaded = await recovery.cloud.partners.fiscalProfile();
  assert.equal(loaded.data.fiscal_profile.status, 'expired');
  assert.equal(loaded.data.fiscal_profile.declaration_version, null);

  for (const status of ['pending', 'verified', 'rejected']) {
    const invalid = clone(envelope);
    invalid.data.fiscal_profile.status = status;
    const client = loadCloudApi(invalid);
    await assert.rejects(
      client.cloud.partners.fiscalProfile(),
      (error) => error?.code === 'partners_contract_invalid',
      `${status} must never be accepted without recorded self-attestation`,
    );
  }
});

test('Partners Web exposes reconfiguration only for a historically completed payout request', async () => {
  const envelope = {
    version: '2026-07-29',
    correlationId: 'payout-reconfiguration-contract',
    data: {
      schema_version: 1,
      action: 'payout_onboarding_loaded',
      payout_onboarding: {
        exists: true,
        status: 'completed',
        currency: 'USD',
        execution_adapter: 'revolut_manual',
        reconfiguration_required: true,
        requested_at: '2026-08-02T12:00:00Z',
        updated_at: '2026-08-02T13:00:00Z',
        reason_code: null,
      },
      allowed_currencies: ['USD'],
    },
  };
  const client = loadCloudApi(envelope);
  const loaded = await client.cloud.partners.payoutOnboarding();
  assert.equal(loaded.data.payout_onboarding.reconfiguration_required, true);

  const invalid = clone(envelope);
  invalid.data.payout_onboarding.status = 'pending';
  const failClosed = loadCloudApi(invalid);
  await assert.rejects(
    failClosed.cloud.partners.payoutOnboarding(),
    (error) => error?.code === 'partners_contract_invalid',
  );
});

test('Partners rejects unsorted payout currencies and non-whitelisted rejection reasons', async () => {
  const base = {
    version: '2026-07-29',
    correlationId: 'payout-onboarding-order-contract',
    data: {
      schema_version: 1,
      action: 'payout_onboarding_loaded',
      payout_onboarding: {
        exists: false,
        status: 'not_started',
        currency: null,
        execution_adapter: 'revolut_manual',
        reconfiguration_required: false,
        requested_at: null,
        updated_at: null,
        reason_code: null,
      },
      allowed_currencies: ['USD', 'EUR'],
    },
  };
  const unsorted = loadCloudApi(base).cloud;
  await assert.rejects(
    unsorted.partners.payoutOnboarding(),
    (error) => error?.code === 'partners_contract_invalid',
  );

  const invalidReason = structuredClone(base);
  invalidReason.data.allowed_currencies = ['EUR', 'USD'];
  invalidReason.data.payout_onboarding = {
    exists: true,
    status: 'rejected',
    currency: 'USD',
    execution_adapter: 'revolut_manual',
    requested_at: '2026-08-02T12:00:00Z',
    updated_at: '2026-08-02T12:05:00Z',
    reason_code: 'arbitrary_internal_reason',
  };
  const rejected = loadCloudApi(invalidReason).cloud;
  await assert.rejects(
    rejected.partners.payoutOnboarding(),
    (error) => error?.code === 'partners_contract_invalid',
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
    (value) => { value.data.program.payout_thresholds.USD = 999; },
    (value) => { delete value.data.program.payout_thresholds.USD; },
    (value) => { delete value.data.program.payout_thresholds.EUR; },
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

test('Cloud discovery remains visible while a slow eligibility probe aborts safely', async () => {
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
  assert.equal(outcome, true);
  assert.equal(settingsRow.hidden, false);
  assert.equal(settingsRow.attributes['aria-hidden'], 'false');
});

test('closed programme states expose only reviewed early access and keep operational controls locked', async () => {
  const container = {
    innerHTML: '',
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  let requestStatus = null;
  const window = {
    NorvaRegions: {
      COUNTRIES: [{ code: 'FR', name: 'France', flag: '🇫🇷', kind: 'country' }],
    },
    NorvaCloud: {
      partners: {
        accessRequest: {
          async get() {
            return {
              data: {
                schema_version: 1,
                program_preview: {
                  commission_rate_bps: 2000,
                  attribution_window_days: 30,
                  maturation_days: 45,
                  payout_thresholds: { USD: 1000 },
                },
                request: requestStatus ? {
                  exists: true,
                  status: requestStatus,
                  country_code: 'FR',
                  subdivision_code: null,
                  requested_at: '2026-08-01T10:00:00Z',
                  reviewed_at: requestStatus === 'declined' ? '2026-08-02T10:00:00Z' : null,
                } : {
                  exists: false,
                  status: null,
                  country_code: null,
                  subdivision_code: null,
                  requested_at: null,
                  reviewed_at: null,
                },
              },
            };
          },
          async request() { throw new Error('not called'); },
        },
      },
    },
  };
  const context = vm.createContext({
    window,
    document: {
      activeElement: null,
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
  const page = new window.PartnersPage({ currentUser: { cloud: true, device: false } });
  page._visible = true;
  const data = validEnvelope().data;
  data.flags.partners_enabled = false;
  data.visibility = { visible: false, reason: 'disabled' };
  data.eligibility = { eligible: false, reason: 'disabled' };
  data.program = null;
  data.policy = null;
  data.allowlist = { required: true, included: false };

  await page.loadEarlyAccessRequest(data, 'disabled');
  assert.match(container.innerHTML, /Earn 20% on eligible referrals/);
  assert.match(container.innerHTML, /data-partners-access-request-form/);
  assert.match(container.innerHTML, /Request access/);
  assert.doesNotMatch(container.innerHTML, /data-partners-(?:join|start-kyc|share|payout-button)/);

  requestStatus = 'declined';
  await page.loadEarlyAccessRequest(data, 'disabled');
  assert.match(container.innerHTML, /This early-access request was not approved/);
  assert.match(container.innerHTML, /support\.html\?returnTo=%2Fapp%23partners/);
  assert.doesNotMatch(container.innerHTML, /data-partners-access-request-form|Request access again/);
  assert.doesNotMatch(container.innerHTML, /data-partners-(?:join|start-kyc|share|payout-button)/);
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

test('dashboard and payout modules time out independently and fail closed', async () => {
  const attributes = new Map();
  const content = {
    innerHTML: '',
    setAttribute(name, value) { attributes.set(`content:${name}`, value); },
    removeAttribute(name) { attributes.delete(`content:${name}`); },
    querySelector: () => null,
  };
  const metrics = {
    innerHTML: '<article><strong>€999.00</strong></article>',
    setAttribute(name, value) { attributes.set(`metrics:${name}`, value); },
    removeAttribute(name) { attributes.delete(`metrics:${name}`); },
  };
  const payoutSummary = { innerHTML: '' };
  const payoutButton = {
    disabled: true,
    textContent: '',
    title: '',
    removeAttribute(name) { attributes.delete(`payout:${name}`); },
  };
  const shell = {
    scrollTop: 120,
    addEventListener() {},
  };
  const container = {
    querySelector(selector) {
      return ({
        '[data-partners-dashboard-content]': content,
        '[data-partners-dashboard-metrics]': metrics,
        '[data-partners-payout-summary]': payoutSummary,
        '[data-partners-payout-button]': payoutButton,
        '.partners-shell': shell,
      })[selector] || null;
    },
    querySelectorAll: () => [],
  };
  const never = ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      const error = new Error('raw timeout detail');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  const window = {
    NorvaCloud: {
      partners: {
        dashboard: never,
        payoutProfile: never,
      },
    },
  };
  const context = vm.createContext({
    window,
    document: {
      activeElement: null,
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
  const page = new window.PartnersPage({ currentUser: { cloud: true, device: false } });
  page._visible = true;
  page._dashboardTimeoutMs = 10;
  page._payoutTimeoutMs = 10;
  let status = '';
  page.setActionStatus = (message) => { status = message; };

  await Promise.all([
    page.loadDashboard(validEnvelope().data, { reset: true }),
    page.loadPayoutProfile(),
  ]);

  assert.match(content.innerHTML, /Dashboard temporarily unavailable/);
  assert.match(content.innerHTML, /secure request took too long/);
  assert.doesNotMatch(content.innerHTML, /raw timeout detail/);
  assert.match(metrics.innerHTML, /Available payout/);
  assert.match(metrics.innerHTML, /Unavailable/);
  assert.doesNotMatch(metrics.innerHTML, /€999\.00/);
  assert.equal(payoutButton.disabled, false);
  assert.equal(payoutButton.textContent, 'Retry payout status');
  assert.match(payoutSummary.innerHTML, /secure status check took too long/);
  assert.doesNotMatch(payoutSummary.innerHTML, /raw timeout detail/);
  assert.match(status, /could not complete this action securely/i);
  assert.equal(page._dashboardAbort, null);
  assert.equal(page._payoutAbort, null);
});

test('partial join completion keeps idempotency and reloads the authoritative state', async () => {
  const listeners = new Map();
  const makeControl = ({ checked = false, textContent = '' } = {}) => ({
    checked,
    disabled: false,
    isConnected: true,
    textContent,
    attributes: new Map(),
    addEventListener(name, listener) { listeners.set(`${textContent || 'form'}:${name}`, listener); },
    setAttribute(name, value) { this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes.delete(name); },
    focus() {},
  });
  const individual = makeControl({ checked: true, textContent: 'individual' });
  const terms = makeControl({ checked: true, textContent: 'terms' });
  const button = makeControl({ textContent: 'Join Norva Partners' });
  const form = makeControl({ textContent: 'join-form' });
  form.querySelector = (selector) => ({
    '[data-partners-individual-confirm]': individual,
    '[data-partners-terms-confirm]': terms,
    '[data-partners-join]': button,
  })[selector] || null;
  const status = {
    textContent: '',
    setAttribute() {},
  };
  const shell = {
    setAttribute() {},
    removeAttribute() {},
  };
  const container = {
    querySelector(selector) {
      return ({
        '[data-partners-join-form]': form,
        '[data-partners-action-status]': status,
        '.partners-shell': shell,
      })[selector] || null;
    },
  };
  let applyCalls = 0;
  let acceptCalls = 0;
  const window = {
    NorvaCloud: {
      partners: {
        apply: async () => { applyCalls += 1; },
        acceptTerms: async () => {
          acceptCalls += 1;
          const error = new Error('raw provider response');
          error.code = 'provider_temporarily_unavailable';
          throw error;
        },
      },
    },
  };
  const context = vm.createContext({
    window,
    document: { getElementById: (id) => (id === 'page-partners' ? container : null) },
    navigator: { language: 'en-US', onLine: true },
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000001' },
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
  let reloads = 0;
  page.show = async () => { reloads += 1; };
  page.bindDiscoveryActions(validEnvelope().data);

  await listeners.get('join-form:submit')({ preventDefault() {} });

  assert.equal(applyCalls, 1);
  assert.equal(acceptCalls, 1);
  assert.equal(reloads, 1);
  assert.equal(page._actionKeys.has('application'), true);
  assert.equal(page._actionKeys.has('terms'), true);
  assert.match(status.textContent, /identity provider is temporarily unavailable/i);
  assert.doesNotMatch(status.textContent, /raw provider response/);
});

test('pending partner states always expose the authoritative recovery action', () => {
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
  data.account = {
    exists: true,
    status: 'pending_verification',
    account_type: 'individual',
    verification_status: 'failed',
    contract_status: 'accepted',
    link_status: 'none',
  };

  page.renderPending(data);
  assert.match(container.innerHTML, /Verification incomplete/);
  assert.match(container.innerHTML, /data-partners-start-kyc disabled/);
  assert.match(container.innerHTML, />Retry identity verification</);

  data.account.verification_status = 'expired';
  page.renderPending(data);
  assert.match(container.innerHTML, /Verification expired/);
  assert.match(container.innerHTML, />Retry identity verification</);

  data.account.verification_status = 'verified';
  page.renderPending(data);
  assert.match(container.innerHTML, /Activation in progress/);
  assert.match(container.innerHTML, /data-partners-refresh-verification/);
  assert.match(container.innerHTML, />Check activation status</);

  data.account.contract_status = 'expired';
  page.renderPending(data);
  assert.match(container.innerHTML, /Application received/);
  assert.match(container.innerHTML, /data-partners-accept-terms/);
  assert.doesNotMatch(container.innerHTML, /Secure next step unavailable/);
});

test('reconcile next_action overrides stale contract state and exposes support safely', () => {
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
  data.account = {
    exists: true,
    status: 'pending_verification',
    account_type: 'individual',
    verification_status: 'verified',
    contract_status: 'accepted',
    link_status: 'none',
  };

  page.renderPending(data, { nextAction: 'accept_terms' });
  assert.match(container.innerHTML, /Review the current programme terms/);
  assert.match(container.innerHTML, /data-partners-accept-terms/);

  page.renderPending(data, { nextAction: 'contact_support' });
  assert.match(container.innerHTML, /Support required/);
  assert.match(container.innerHTML, /href="\/support\.html\?returnTo=%2Fapp%23partners"/);
  assert.doesNotMatch(container.innerHTML, /data-partners-refresh-verification/);
});

test('foreground load reconciles a verified pending account before rendering', async () => {
  const container = { innerHTML: '', querySelector: () => null };
  const bootstrap = validEnvelope();
  bootstrap.data.visibility = { visible: true, reason: 'existing_account' };
  bootstrap.data.account = {
    exists: true,
    status: 'pending_verification',
    account_type: 'individual',
    verification_status: 'verified',
    contract_status: 'accepted',
    link_status: 'none',
  };
  let reconciles = 0;
  let reconciliation = {
    changed: true,
    next_action: 'share_link',
    account: {
      exists: true,
      status: 'active',
      verification_status: 'verified',
      contract_status: 'accepted',
      link_status: 'active',
    },
  };
  const window = {
    NorvaCloud: {
      token: 'opaque-session',
      partners: {
        bootstrap: async () => bootstrap,
        activation: {
          reconcile: async () => {
            reconciles += 1;
            return { data: reconciliation };
          },
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
  const page = new window.PartnersPage({ currentUser: { cloud: true, device: false } });
  page.renderLoading = () => {};
  page.setEntryVisibility = () => true;
  let rendered = null;
  page.renderBootstrap = (data, options) => { rendered = { data, options }; };

  await page.show();

  assert.equal(reconciles, 1);
  assert.equal(rendered.data.account.status, 'active');
  assert.equal(rendered.data.account.account_type, 'individual');
  assert.equal(rendered.options.nextAction, 'share_link');

  bootstrap.data.account.verification_status = 'not_started';
  reconciliation = {
    changed: false,
    next_action: 'accept_terms',
    account: {
      exists: true,
      status: 'pending_verification',
      verification_status: 'not_started',
      contract_status: 'accepted',
      link_status: 'none',
    },
  };
  await page.show();
  assert.equal(reconciles, 2, 'terms drift is reconciled before KYC starts');
  assert.equal(rendered.options.nextAction, 'accept_terms');
});

test('unknown-result recovery retries exact mutations and never infers success from GET state', () => {
  assert.match(pageSource, /const submitAttestation = \(\) =>[\s\S]*idempotencyKey[\s\S]*envelope = await submitAttestation\(\)[\s\S]*envelope = await submitAttestation\(\)/);
  assert.match(pageSource, /const requestOnboarding = \(\) =>[\s\S]*idempotencyKey[\s\S]*envelope = await requestOnboarding\(\)[\s\S]*envelope = await requestOnboarding\(\)/);
  assert.doesNotMatch(pageSource, /current\.status !== 'missing'/);
  assert.doesNotMatch(pageSource, /current\.status !== 'not_started'/);
});

test('hosted Didit hand-off requires both confirmations and preserves its retry key', async () => {
  const listeners = new Map();
  const makeControl = ({ checked = false, textContent = '' } = {}) => ({
    checked,
    disabled: false,
    isConnected: true,
    textContent,
    attributes: new Map(),
    addEventListener(name, listener) { listeners.set(`${textContent || 'form'}:${name}`, listener); },
    setAttribute(name, value) { this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes.delete(name); },
    focus() {},
  });
  const consent = makeControl({ checked: true, textContent: 'kyc-consent' });
  const capacity = makeControl({ checked: true, textContent: 'capacity' });
  const button = makeControl({ textContent: 'Verify my identity securely' });
  const form = makeControl({ textContent: 'kyc-form' });
  form.querySelector = (selector) => ({
    '[data-partners-kyc-consent]': consent,
    '[data-partners-capacity-confirm]': capacity,
    '[data-partners-start-kyc]': button,
  })[selector] || null;
  const status = { textContent: '', setAttribute() {} };
  const shell = { setAttribute() {}, removeAttribute() {} };
  const container = {
    querySelector(selector) {
      return ({
        '[data-partners-accept-terms]': null,
        '[data-partners-kyc-form]': form,
        '[data-partners-action-status]': status,
        '[data-partners-refresh-verification]': null,
        '.partners-shell': shell,
      })[selector] || null;
    },
  };
  const calls = [];
  let assigned = '';
  const window = {
    location: { assign(value) { assigned = value; } },
    NorvaCloud: {
      partners: {
        async startKyc(input) {
          calls.push({ ...input });
          return {
            data: {
              verification: { url: 'https://verify.didit.me/session/opaque-result' },
            },
          };
        },
      },
    },
  };
  const context = vm.createContext({
    window,
    document: {
      documentElement: { lang: 'en' },
      getElementById: (id) => (id === 'page-partners' ? container : null),
    },
    navigator: { language: 'en-US', onLine: true },
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000002' },
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
  data.account = {
    exists: true,
    status: 'pending_verification',
    account_type: 'individual',
    verification_status: 'not_started',
    contract_status: 'accepted',
    link_status: 'none',
  };
  page.bindPendingActions(data);

  await listeners.get('kyc-form:submit')({ preventDefault() {} });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].language, 'en');
  assert.equal(calls[0].consentVersion, 'partners-fr-v1');
  assert.equal(
    calls[0].biometricConsentVersion,
    'partners-biometric-consent-v1',
  );
  assert.equal(calls[0].capacityConfirmed, true);
  assert.match(calls[0].idempotencyKey, /^norva\.kyc-session\./);
  assert.equal(assigned, 'https://verify.didit.me/session/opaque-result');
  assert.equal(page._actionKeys.has('kyc-session'), true);
  assert.match(status.textContent, /Opening Didit/);
});

test('an active account without a link can create one from the server', async () => {
  const listeners = new Map();
  const button = {
    disabled: false,
    isConnected: true,
    textContent: 'Create referral link',
    addEventListener(name, listener) { listeners.set(name, listener); },
    setAttribute() {},
    removeAttribute() {},
  };
  const status = { textContent: '', setAttribute() {} };
  const shell = { setAttribute() {}, removeAttribute() {} };
  const container = {
    querySelector(selector) {
      return ({
        '[data-partners-create-link]': button,
        '[data-partners-action-status]': status,
        '[data-partners-history-more]': null,
        '.partners-shell': shell,
      })[selector] || null;
    },
    querySelectorAll: () => [],
  };
  const rotateCalls = [];
  const window = {
    NorvaCloud: {
      partners: {
        async rotateLink(input) { rotateCalls.push({ ...input }); },
      },
    },
  };
  const context = vm.createContext({
    window,
    document: { getElementById: (id) => (id === 'page-partners' ? container : null) },
    navigator: { language: 'en-US', onLine: true },
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000003' },
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
  let dashboardReloads = 0;
  page.loadDashboard = async () => { dashboardReloads += 1; };
  page.bindDashboardActions(validEnvelope().data, { link: null });

  await listeners.get('click')({ currentTarget: button });

  assert.equal(rotateCalls.length, 1);
  assert.match(rotateCalls[0].idempotencyKey, /^norva\.link-rotation\./);
  assert.equal(dashboardReloads, 1);
  assert.match(status.textContent, /Referral link created/);
  assert.equal(page._actionKeys.has('link-rotation'), false);
});

test('Clipboard rejection falls back to the complete disclosure payload and restores focus', async () => {
  const payload = [
    'Discover Norva — one media ecosystem across Web, Android and TV.',
    '',
    'Publicité — lien partenaire Norva · Je peux recevoir 20 % des paiements Norva éligibles hors taxes.',
    `https://norva.tv/r/${'A'.repeat(32)}`,
  ].join('\n');
  const restoredRanges = [];
  const previousRange = { id: 'existing-selection' };
  const selection = {
    rangeCount: 1,
    getRangeAt: () => ({ cloneRange: () => previousRange }),
    removeAllRanges() { restoredRanges.length = 0; },
    addRange(range) { restoredRanges.push(range); },
  };
  let focused = 0;
  const trigger = { focus() { focused += 1; } };
  const attributes = new Map();
  const fallback = {
    value: '',
    readOnly: false,
    tabIndex: 0,
    style: {},
    removed: false,
    selection: null,
    setAttribute(name, value) { attributes.set(name, value); },
    focus() {},
    select() { this.selection = [0, this.value.length]; },
    setSelectionRange(start, end) { this.selection = [start, end]; },
    remove() { this.removed = true; },
  };
  let appended = null;
  let copied = null;
  let modernAttempts = 0;
  const document = {
    activeElement: trigger,
    body: { appendChild(node) { appended = node; } },
    documentElement: {},
    createElement(tagName) {
      assert.equal(tagName, 'textarea');
      return fallback;
    },
    getSelection: () => selection,
    execCommand(command) {
      assert.equal(command, 'copy');
      assert.equal(appended, fallback);
      copied = fallback.value.slice(...fallback.selection);
      return true;
    },
    getElementById: () => null,
  };
  const window = {};
  const context = vm.createContext({
    window,
    document,
    navigator: {
      language: 'en-US',
      clipboard: {
        async writeText() {
          modernAttempts += 1;
          throw new Error('clipboard permission denied');
        },
      },
    },
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

  await page.copyText(payload);

  assert.equal(copied, payload);
  assert.equal(fallback.value, payload);
  assert.equal(fallback.readOnly, true);
  assert.equal(fallback.tabIndex, -1);
  assert.equal(attributes.get('aria-hidden'), 'true');
  assert.equal(fallback.removed, true);
  assert.deepEqual(restoredRanges, [previousRange]);
  assert.equal(focused, 1);
  assert.equal(modernAttempts, 1);
});

test('dashboard Copy action uses the canonical disclosure payload, never the bare URL', async () => {
  const listeners = new Map();
  const button = {
    disabled: false,
    isConnected: true,
    textContent: 'Copy share text',
    addEventListener(name, listener) { listeners.set(name, listener); },
  };
  const container = {
    querySelector(selector) {
      return selector === '[data-partners-copy]' ? button : null;
    },
    querySelectorAll: () => [],
  };
  const window = {};
  const context = vm.createContext({
    window,
    document: { getElementById: (id) => (id === 'page-partners' ? container : null) },
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
  const bootstrap = validEnvelope().data;
  const dashboard = validDashboardEnvelope().data;
  let copied = null;
  let status = null;
  page.runPartnerAction = async (_button, _label, action) => action();
  page.copyText = async (value) => { copied = value; };
  page.setActionStatus = (value) => { status = value; };

  page.bindDashboardActions(bootstrap, dashboard);
  await listeners.get('click')({ currentTarget: button });

  const content = page.shareContent(dashboard.link.share_url, bootstrap);
  assert.equal(copied, content.text);
  assert.notEqual(copied, dashboard.link.share_url);
  assert.match(copied, /I may receive 20%/);
  assert.match(copied, /Earnings are not guaranteed/);
  assert.match(copied, new RegExp(`${'A'.repeat(32)}$`));
  assert.equal(status, 'Referral message and required disclosure copied.');
});

test('share disclosure follows the audience language contract', () => {
  const window = {};
  const context = vm.createContext({
    window,
    document: {
      documentElement: { lang: 'fr-FR' },
      getElementById: () => null,
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
  vm.runInContext(pageSource, context, {
    filename: 'public/js/pages/PartnersPage.js',
  });
  const page = new window.PartnersPage({
    currentUser: { cloud: true, device: false },
  });
  const disclosure = page.shareDisclosure(validEnvelope().data);
  assert.match(disclosure, /^Publicité — lien partenaire Norva/);
  assert.match(disclosure, /Je peux recevoir 20 %/);
});

test('double clipboard failure returns one stable public error without success', async () => {
  let removed = false;
  let focused = 0;
  const trigger = { focus() { focused += 1; } };
  const fallback = {
    value: '',
    style: {},
    setAttribute() {},
    focus() {},
    select() {},
    setSelectionRange() {},
    remove() { removed = true; },
  };
  const document = {
    activeElement: trigger,
    body: { appendChild() {} },
    documentElement: {},
    createElement: () => fallback,
    getSelection: () => null,
    execCommand: () => false,
    getElementById: () => null,
  };
  const window = {};
  const context = vm.createContext({
    window,
    document,
    navigator: {
      language: 'en-US',
      onLine: true,
      clipboard: { async writeText() { throw new Error('clipboard unavailable'); } },
    },
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

  await assert.rejects(
    () => page.copyText('complete disclosure payload'),
    (error) => error?.code === 'partners_copy_unavailable',
  );

  assert.equal(removed, true);
  assert.equal(focused, 1);
  assert.equal(
    page.partnerErrorMessage({ code: 'partners_copy_unavailable' }),
    'Copying is unavailable in this browser. No referral message was copied.',
  );
});

test('discovery copy uses the authoritative programme maturation period', () => {
  const window = {};
  const context = vm.createContext({
    window,
    document: { getElementById: () => null },
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

  const markup = page.steps({ maturation_days: 61 });

  assert.match(markup, /Commission matures after 61 days/);
  assert.doesNotMatch(markup, /after 45 days/);
  assert.match(page.steps(null), /server-published validation period/);
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
  assert.equal(page.resolveView(data), 'pending');
  data.account.verification_status = 'expired';
  assert.equal(page.resolveView(data), 'pending');
  data.account.verification_status = 'verified';
  data.account.contract_status = 'expired';
  assert.equal(page.resolveView(data), 'pending');

  data.account.contract_status = 'accepted';
  data.account.status = 'active';
  data.account.link_status = 'revoked';
  assert.equal(
    page.resolveView(data),
    'active',
    'an otherwise active account can securely create a replacement link',
  );

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

test('Partners is a secondary discoverable route whose operational actions stay server-gated', () => {
  assert.match(htmlSource, /id="settings-partners-row"\s+hidden\s+aria-hidden="true"/);
  assert.match(htmlSource, /id="page-partners"\s+class="page"/);
  assert.match(htmlSource, /src="\/js\/vendor\/qrcode\.js\?v=1"/);
  assert.match(htmlSource, /src="\/js\/pages\/PartnersPage\.js\?v=10"/);
  assert.doesNotMatch(htmlSource, /class="nav-link"[^>]*data-page="partners"/);
  assert.match(appSource, /this\.pages\.partners\s*=\s*new PartnersPage\(this\)/);
  assert.match(appSource, /data-act="partners"\s+hidden\s+aria-hidden="true"/);
  assert.match(appSource, /primeVisibility\?\.\(\)\.catch\(\(\) => \{\}\)/);
  assert.match(pageSource, /canDiscoverUserPartners\(\)/);
  assert.match(pageSource, /accessRequest/);
  assert.match(appSource, /claimPendingPartnerReferral\(\)/);
  assert.match(appSource, /NorvaCloud\.partners\.claimReferral\(\)/);
  assert.match(settingsSource, /void this\.refreshPartnersEntry\(\)\.catch\(\(\) => \{\}\)/);
  assert.doesNotMatch(pageSource, /localStorage|sessionStorage/);
  assert.doesNotMatch(pageSource, /referral[_-]?(?:code|token)\s*=/i);
  assert.match(pageSource, /data-partners-membership-join disabled/);
  assert.match(pageSource, /data-partners-terms-confirm/);
  assert.match(pageSource, /data-partners-disclosure-confirm/);
  assert.match(pageSource, /without KYC; Didit is reserved for optional cash transfers/);
  assert.match(pageSource, /window\.NorvaCloud\.partners\.apply/);
  assert.match(pageSource, /window\.NorvaCloud\.partners\.acceptTerms/);
  assert.match(pageSource, /window\.NorvaCloud\.partners\.rotateLink/);
  assert.match(pageSource, /openPayoutDialog\(this\._payoutProfile, button\)/);
  assert.match(pageSource, /Manual Revolut destinations are provisioned by Norva Finance/);
  assert.match(pageSource, /This page never accepts an IBAN, card number, tax identifier or beneficiary token/);
  assert.doesNotMatch(pageSource, /saveTokenizedPayoutProfile/);
  assert.match(pageSource, /payout_thresholds\?\.USD/);
  assert.match(pageSource, /Reference payout threshold/);
  assert.match(pageSource, /Payout thresholds before you accept/);
  assert.match(pageSource, /Exact settlement payout thresholds for your policy/);
  assert.match(pageSource, /policy\?\.payout_currencies/);
  assert.match(pageSource, /'discovery'/);
  assert.match(pageSource, /'pending'/);
  assert.match(pageSource, /'dashboard'/);
  assert.match(pageSource, /Each threshold is exact in its named settlement currency/);
  assert.match(pageSource, /Norva absorbs payout-transfer fees on supported routes/);
  assert.match(pageSource, /Available balance can fund Norva access without identity verification/);
  assert.match(cloudSource, /value\.USD === 1000/);
  assert.match(cloudSource, /data\.policy\.payout_currencies\.some/);
  assert.match(pageSource, /window\.NorvaCloud\.partners\.dashboard/);
  const partnersNamespaceStart = cloudSource.indexOf('partners: Object.freeze({');
  const partnersNamespaceEnd = cloudSource.indexOf('\n        profile:', partnersNamespaceStart);
  assert.ok(partnersNamespaceStart >= 0 && partnersNamespaceEnd > partnersNamespaceStart);
  const partnersNamespace = cloudSource.slice(partnersNamespaceStart, partnersNamespaceEnd);
  for (const binding of [
    'bootstrap: partnersBootstrap',
    'join: partnersJoin',
    'get: partnersAccessRequestGet',
    'request: partnersAccessRequestSubmit',
    'apply: partnersApply',
    'acceptTerms: partnersAcceptTerms',
    'rotateLink: partnersRotateLink',
    'startKyc: partnersStartKyc',
    'claimReferral: partnersClaimReferral',
    'payoutProfile: partnersPayoutProfile',
    'dashboard: partnersDashboard',
  ]) {
    assert.match(partnersNamespace, new RegExp(binding.replace(': ', ':\\s*')));
  }
  assert.doesNotMatch(partnersNamespace, /saveTokenizedPayoutProfile/);
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
  assert.match(
    pageSource,
    /Identity verification is never required to share, earn or convert/,
  );
  assert.match(pageSource, /header\('Checking availability', 'partners-title'\)/);
  assert.match(pageSource, /Attribution window:<\/strong> \$\{days\} days/);
  assert.match(
    pageSource,
    /label: 'Referral tracking window'[\s\S]{0,160}value: `\$\{attributionDays\} days`/,
  );
  assert.match(pageSource, /aria-label="More information about \$\{this\.escape\(fact\.label\)\}"/);
  assert.doesNotMatch(pageSource, /verifies an individual identity, residence/i);
  assert.doesNotMatch(pageSource, /(?:error|err)\?*\.message/);
  assert.match(pageSource, /aria-live="\$\{politeness\}"/);
  assert.match(pageSource, /aria-busy="true"/);
  assert.match(pageSource, /_dashboardTimeoutMs\s*=\s*10000/);
  assert.match(pageSource, /_payoutTimeoutMs\s*=\s*8000/);
  assert.match(pageSource, /captureDashboardContext/);
  assert.match(pageSource, /restoreDashboardContext/);
  assert.match(pageSource, /isolateOverlayBackground/);
  assert.match(pageSource, /trapDialogFocus/);
  assert.match(
    pageSource,
    /document\.addEventListener\('keydown', handleDialogKeydown, true\)/,
    'the payout dialog must retain Escape and Back handling while async rendering detaches focus',
  );
  assert.match(
    pageSource,
    /document\.removeEventListener\('keydown', handleDialogKeydown, true\)/,
    'the document-level payout dialog listener must be removed on every close path',
  );
  assert.match(
    pageSource,
    /!dialog\.contains\(document\.activeElement\)/,
    'the focus trap must recover if an async rerender temporarily moves focus outside the dialog',
  );
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
    /\.partners-shell \.btn:disabled,\s*\.partners-shell \.btn\[aria-disabled="true"\]\s*\{[\s\S]{0,100}color:\s*var\(--color-text-muted\)/,
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
  const { createDefaultNavigationModel } = require('../public/js/navigation/NavigationModel.js');
  const navigationModel = createDefaultNavigationModel();
  assert.deepEqual(navigationModel.continuityPageNames(), [
    'home', 'live', 'movies', 'series', 'settings', 'partners',
  ]);
  assert.match(
    appSource,
    /this\.navigation\?\.model\?\.continuityPageNames\?\.\(\)/,
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
  assert.match(serviceWorkerSource, /CACHE_VERSION\s*=\s*'norva-sw-v11'/);
  assert.match(cssSource, /\.main-content\s*\{\s*padding-bottom:\s*var\(--bottom-nav-h\)/);
  assert.match(
    cssSource,
    /\.partners-shell[\s\S]{0,500}scroll-padding-block:[^;]*var\(--bottom-nav-h\)/,
  );
  assert.match(htmlSource, /main\.css\?v=108/);
  assert.match(htmlSource, /cloudApi\.js\?v=62/);
  assert.match(htmlSource, /standalone\.js\?v=12/);
  assert.match(htmlSource, /Settings\.js\?v=52/);
  assert.match(htmlSource, /PartnersPage\.js\?v=10/);
  assert.match(htmlSource, /app\.js\?v=73/);
  assert.match(appSource, /AdminPage\.js\?v=[0-9a-f]{10}/);
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
    /sanitizedCertificationReturn[\s\S]{0,900}url\.hash = certificationReturn \? '#admin\/partners' : '#partners'[\s\S]{0,260}history\.replaceState/,
  );
  assert.match(appSource, /sanitizedBoundaryReturn[\s\S]{0,160}#partners\/kyc-return/);
  assert.match(pageSource, /consumePartnersKycReturnNotice/);
  assert.match(pageSource, /Back in Norva\. Checking for the signed identity result/);
  assert.match(pageSource, /cashKycProgressMarkup/);
  assert.match(pageSource, /dashboard\.membership[\s\S]{0,120}dashboard\.cash_readiness/);
  assert.match(appSource, /NORVA_PARTNERS_KYC_CERTIFICATION_RETURN_TTL_MS/);
  assert.match(appSource, /url\.hash === '#partners'/);
  assert.match(appSource, /consumePartnersKycCertificationReturnNotice/);
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
