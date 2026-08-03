const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const helperSource = read('supabase/functions/_shared/partners-api.ts');
const edgeSource = read('supabase/functions/norva-partners/index.ts');
const configSource = read('supabase/config.toml');
const contractSource = read('docs/NORVA-PARTNERS-API-CONTRACT.md');
const foundationMigration = read(
  'supabase/migrations/20260729173015_norva_partners_foundation.sql',
);
const fiscalPayoutMigration = read(
  'supabase/migrations/20260802190000_partners_fiscal_payout_onboarding.sql',
);
const memberWriteRateMigration = read(
  'supabase/migrations/20260802193000_partners_member_write_rate_limits.sql',
);

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
  });
  return module.exports;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function validBootstrap() {
  return {
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
      subdivision_code: null,
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
  };
}

function validMemberAccount(includeJurisdiction = false) {
  const account = {
    exists: true,
    status: 'pending_verification',
    verification_status: 'not_started',
    contract_status: 'not_accepted',
    link_status: 'none',
  };
  if (includeJurisdiction) {
    Object.assign(account, {
      country_code: 'FR',
      subdivision_code: 'FR-IDF',
      created_at: '2026-07-29T12:00:00Z',
      updated_at: '2026-07-29T12:01:00Z',
    });
  }
  return account;
}

function validDashboard(status = 'all') {
  const activityStatus = status === 'all' ? 'pending' : status;
  return {
    schema_version: 1,
    account: validMemberAccount(true),
    link: null,
    reporting: {
      available: true,
      reason: 'available',
      currency: 'EUR',
      clicks: 18,
      referrals: 4,
      pending_minor: 1250,
      available_minor: 800,
      paid_minor: 2400,
      currencies: [{
        currency: 'EUR',
        pending_minor: 1250,
        available_minor: 800,
        paid_minor: 2400,
        payout_destination_ready: false,
      }],
    },
    history: {
      status,
      items: [
        {
          type: `commission_${activityStatus}`,
          occurred_at: '2026-07-29T12:00:00Z',
        },
      ],
      next_cursor: 'history_00000000000000000001',
    },
  };
}

test('Partners CORS is an exact allowlist with no wildcard or implicit localhost', () => {
  const {
    parseAllowedOrigins,
    assertAllowedOrigin,
    assertValidPreflight,
    corsHeaders,
  } = helpers();
  const productionDefaults = plain(parseAllowedOrigins(null));
  assert.ok(productionDefaults.includes('https://norva.tv'));
  assert.equal(
    productionDefaults.some((origin) => origin.startsWith('http://localhost:')),
    false,
    'localhost must be configured explicitly outside production',
  );
  const origins = plain(parseAllowedOrigins('https://norva.tv,http://localhost:3000'));
  assert.deepEqual(origins, ['https://norva.tv', 'http://localhost:3000']);
  assert.throws(() => parseAllowedOrigins('*'));
  assert.throws(() => parseAllowedOrigins('https://norva.tv/'));
  assert.throws(() => assertAllowedOrigin('https://evil.example', origins));
  assert.doesNotThrow(() => assertAllowedOrigin(null, origins), 'native clients have no Origin');
  assert.doesNotThrow(() => assertValidPreflight(
    'https://norva.tv',
    'POST',
    'authorization, apikey, content-type, idempotency-key',
    origins,
    ['POST'],
  ));
  assert.throws(() => assertValidPreflight(
    'https://norva.tv',
    'POST',
    'authorization',
    origins,
  ));
  assert.throws(() => assertValidPreflight(
    'https://norva.tv',
    'GET',
    'authorization, x-user-id',
    origins,
  ));
  assert.throws(() => assertValidPreflight(
    'https://norva.tv',
    'GET',
    'authorization, x-norva-profile-id',
    origins,
  ));
  assert.equal(
    corsHeaders('https://evil.example', origins)['Access-Control-Allow-Origin'],
    undefined,
  );
});

test('bootstrap query is bounded, normalized and never accepts a client user id', () => {
  const { parseBootstrapQuery } = helpers();
  assert.deepEqual(
    plain(parseBootstrapQuery(new URL('https://example.test/bootstrap?countryCode=fr&subdivisionCode=fr-idf'))),
    { countryCode: 'FR', subdivisionCode: 'FR-IDF' },
  );
  assert.deepEqual(
    plain(parseBootstrapQuery(new URL('https://example.test/bootstrap'))),
    { countryCode: null, subdivisionCode: null },
  );
  for (const url of [
    'https://example.test/bootstrap?userId=385d8450-1111-4111-8111-111111111111',
    'https://example.test/bootstrap?countryCode=FR&countryCode=US',
    'https://example.test/bootstrap?countryCode=FRA',
    'https://example.test/bootstrap?countryCode=FR&subdivisionCode=US-CA',
    'https://example.test/bootstrap?countryCode=US&subdivisionCode=USX-CA',
    'https://example.test/bootstrap?subdivisionCode=FR-IDF',
    'https://example.test/bootstrap?subdivisionCode=FR--IDF',
  ]) {
    assert.throws(() => parseBootstrapQuery(new URL(url)), url);
  }
});

test('member mutation inputs, idempotency keys and dashboard filters are strictly bounded', () => {
  const {
    allowedMethodsForRoute,
    assertNoQueryParameters,
    parseAcceptTermsInput,
    parseApplicationInput,
    parseDashboardQuery,
    parseEmptyMutationInput,
    parseIdempotencyKey,
  } = helpers();

  assert.deepEqual(plain(parseApplicationInput({
    accountType: 'individual',
    countryCode: 'fr',
    subdivisionCode: 'fr-idf',
  })), {
    accountType: 'individual',
    countryCode: 'FR',
    subdivisionCode: 'FR-IDF',
  });
  assert.throws(
    () => parseApplicationInput({
      accountType: 'business',
      countryCode: 'FR',
    }),
    (error) => (
      error?.code === 'business_accounts_not_supported' &&
      error?.nextState === 'business_waitlist'
    ),
  );
  for (const body of [
    { accountType: 'individual', countryCode: 'FR', userId: 'forbidden' },
    { accountType: 'individual', countryCode: 'FR', subdivisionCode: 'US-CA' },
    { accountType: 'individual', countryCode: 'FRA' },
    { accountType: 'individual' },
  ]) {
    assert.throws(() => parseApplicationInput(body));
  }

  assert.deepEqual(plain(parseAcceptTermsInput({
    termsVersion: 'partners-fr-v1',
    disclosureVersion: 'partners-fr-v1',
  })), {
    termsVersion: 'partners-fr-v1',
    disclosureVersion: 'partners-fr-v1',
  });
  assert.throws(() => parseAcceptTermsInput({
    termsVersion: 'partners-fr-v1',
    disclosureVersion: 'partners-fr-v1',
    verified: true,
  }), 'clients cannot declare a verification result');
  assert.deepEqual(plain(parseEmptyMutationInput({})), {});
  assert.throws(() => parseEmptyMutationInput({ rotateForUserId: 'forbidden' }));

  assert.equal(parseIdempotencyKey('join:0123456789abcdef'), 'join:0123456789abcdef');
  assert.throws(() => parseIdempotencyKey(null));
  assert.throws(() => parseIdempotencyKey('short'));
  assert.throws(() => parseIdempotencyKey('join key with spaces'));

  assert.deepEqual(
    plain(parseDashboardQuery(new URL(
      'https://example.test/dashboard?limit=50&status=pending&cursor=history_00000000000000000001',
    ))),
    {
      historyLimit: 50,
      historyCursor: 'history_00000000000000000001',
      historyStatus: 'pending',
    },
  );
  assert.deepEqual(
    plain(parseDashboardQuery(new URL('https://example.test/dashboard'))),
    { historyLimit: 25, historyCursor: null, historyStatus: 'all' },
  );
  for (const url of [
    'https://example.test/dashboard?limit=0',
    'https://example.test/dashboard?limit=51',
    'https://example.test/dashboard?status=secret',
    'https://example.test/dashboard?cursor=raw-user-id',
    'https://example.test/dashboard?userId=forbidden',
  ]) {
    assert.throws(() => parseDashboardQuery(new URL(url)), url);
  }

  assert.deepEqual(plain(allowedMethodsForRoute('/bootstrap')), ['GET']);
  assert.deepEqual(plain(allowedMethodsForRoute('/dashboard')), ['GET']);
  assert.deepEqual(plain(allowedMethodsForRoute('/applications')), ['POST']);
  assert.deepEqual(plain(allowedMethodsForRoute('/activate')), ['POST']);
  assert.deepEqual(plain(allowedMethodsForRoute('/activation/reconcile')), ['POST']);
  assert.deepEqual(plain(allowedMethodsForRoute('/links')), ['POST']);
  assert.deepEqual(plain(allowedMethodsForRoute('/kyc/sessions')), ['POST']);
  assert.deepEqual(plain(allowedMethodsForRoute('/referral/claim')), ['POST']);
  assert.deepEqual(plain(allowedMethodsForRoute('/payout-profile')), ['GET']);
  assert.deepEqual(plain(allowedMethodsForRoute('/fiscal-profile')), ['GET', 'POST']);
  assert.deepEqual(plain(allowedMethodsForRoute('/payout-onboarding')), ['GET', 'POST']);
  assert.doesNotThrow(() => assertNoQueryParameters(
    new URL('https://example.test/applications'),
  ));
  assert.throws(() => assertNoQueryParameters(
    new URL('https://example.test/applications?userId=forbidden'),
  ));
});

test('fiscal self-attestation and manual payout onboarding expose no user-controlled verification or bank data', () => {
  const {
    parseFiscalProfileInput,
    parsePayoutOnboardingInput,
    sanitizeFiscalProfileGet,
    sanitizeFiscalProfileMutation,
    sanitizePayoutOnboardingGet,
    sanitizePayoutOnboardingMutation,
  } = helpers();

  assert.deepEqual(plain(parseFiscalProfileInput({
    countryCode: 'fr',
    declarationAccepted: true,
    declarationVersion: 'partners-tax-self-certification-v1',
  })), {
    countryCode: 'FR',
    declarationAccepted: true,
    declarationVersion: 'partners-tax-self-certification-v1',
  });
  for (const invalid of [
    {
      countryCode: 'FR',
      declarationAccepted: false,
      declarationVersion: 'partners-tax-self-certification-v1',
    },
    {
      countryCode: 'FR',
      declarationAccepted: true,
      declarationVersion: 'partners-tax-self-certification-v2',
    },
    {
      countryCode: 'FR',
      declarationAccepted: true,
      declarationVersion: 'partners-tax-self-certification-v1',
      status: 'verified',
    },
    {
      countryCode: 'FR',
      declarationAccepted: true,
      declarationVersion: 'partners-tax-self-certification-v1',
      taxIdentifier: 'FR123456789',
    },
  ]) assert.throws(() => parseFiscalProfileInput(invalid));

  const pendingFiscal = {
    schema_version: 1,
    action: 'fiscal_profile_submitted',
    replayed: false,
    fiscal_profile: {
      exists: true,
      status: 'pending',
      country_code: 'FR',
      declaration_version: 'partners-tax-self-certification-v1',
      submitted_at: '2026-08-02T17:00:00Z',
      reviewed_at: null,
    },
  };
  assert.deepEqual(
    plain(sanitizeFiscalProfileMutation(pendingFiscal)),
    pendingFiscal,
  );
  assert.throws(() => sanitizeFiscalProfileMutation({
    ...pendingFiscal,
    fiscal_profile: {
      ...pendingFiscal.fiscal_profile,
      status: 'verified',
      reviewed_at: '2026-08-02T17:01:00Z',
    },
  }), 'the member mutation can never return a user-declared verified state');
  assert.deepEqual(plain(sanitizeFiscalProfileGet({
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
  })).fiscal_profile.status, 'missing');
  assert.deepEqual(plain(sanitizeFiscalProfileGet({
    schema_version: 1,
    action: 'fiscal_profile_loaded',
    fiscal_profile: {
      exists: true,
      status: 'expired',
      country_code: 'US',
      declaration_version: null,
      submitted_at: null,
      reviewed_at: '2026-08-02T16:00:00Z',
    },
  })).fiscal_profile, {
    exists: true,
    status: 'expired',
    country_code: 'US',
    declaration_version: null,
    submitted_at: null,
    reviewed_at: '2026-08-02T16:00:00Z',
  }, 'legacy verification is exposed only as an expired recovery state');
  assert.throws(() => sanitizeFiscalProfileGet({
    schema_version: 1,
    action: 'fiscal_profile_loaded',
    fiscal_profile: {
      exists: true,
      status: 'verified',
      country_code: 'US',
      declaration_version: null,
      submitted_at: null,
      reviewed_at: '2026-08-02T16:00:00Z',
    },
  }), 'verified can never use the legacy null-attestation contract');

  assert.deepEqual(plain(parsePayoutOnboardingInput({
    currency: 'usd',
    contactConsent: true,
  })), { currency: 'USD', contactConsent: true });
  for (const forbidden of [
    { currency: 'USD', contactConsent: false },
    { currency: 'USD', contactConsent: true, provider: 'revolut' },
    { currency: 'USD', contactConsent: true, executionAdapter: 'revolut_api' },
    { currency: 'USD', contactConsent: true, iban: 'FR7630006000011234567890189' },
    { currency: 'USD', contactConsent: true, beneficiaryTokenRef: 'opaque' },
    { currency: 'USD', contactConsent: true, displayMasked: '**** 1234' },
  ]) assert.throws(() => parsePayoutOnboardingInput(forbidden));

  const payoutRequest = {
    schema_version: 1,
    action: 'payout_onboarding_requested',
    replayed: false,
    payout_onboarding: {
      exists: true,
      status: 'pending',
      currency: 'USD',
      execution_adapter: 'revolut_manual',
      reconfiguration_required: false,
      requested_at: '2026-08-02T17:00:00Z',
      updated_at: '2026-08-02T17:00:00Z',
      reason_code: null,
    },
  };
  assert.deepEqual(
    plain(sanitizePayoutOnboardingMutation(payoutRequest)),
    payoutRequest,
  );
  assert.deepEqual(plain(sanitizePayoutOnboardingGet({
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
  })).allowed_currencies, ['EUR', 'USD']);
  assert.equal(plain(sanitizePayoutOnboardingGet({
    schema_version: 1,
    action: 'payout_onboarding_loaded',
    payout_onboarding: {
      exists: true,
      status: 'completed',
      currency: 'USD',
      execution_adapter: 'revolut_manual',
      reconfiguration_required: true,
      requested_at: '2026-08-02T17:00:00Z',
      updated_at: '2026-08-02T18:00:00Z',
      reason_code: null,
    },
    allowed_currencies: ['USD'],
  })).payout_onboarding.reconfiguration_required, true);
  assert.throws(() => sanitizePayoutOnboardingGet({
    schema_version: 1,
    action: 'payout_onboarding_loaded',
    payout_onboarding: {
      ...payoutRequest.payout_onboarding,
      reconfiguration_required: true,
    },
    allowed_currencies: ['USD'],
  }), 'only a historically completed request may require reconfiguration');
  assert.throws(() => sanitizePayoutOnboardingMutation({
    ...payoutRequest,
    payout_onboarding: {
      ...payoutRequest.payout_onboarding,
      beneficiary_token_ref: 'must-never-leave-private-schema',
    },
  }));
});

test('fiscal upgrade, throttling and manual completion fail closed in SQL', () => {
  const migration = fiscalPayoutMigration.toLowerCase();
  const constraintAt = migration.indexOf(
    'add constraint affiliate_fiscal_profiles_self_attestation',
  );
  const legacyRewriteAt = migration.indexOf('with legacy_candidates as materialized');
  const validationAt = migration.indexOf(
    'validate constraint affiliate_fiscal_profiles_self_attestation',
  );
  assert.ok(
    constraintAt >= 0 && constraintAt < legacyRewriteAt && legacyRewriteAt < validationAt,
    'new writes are constrained before legacy rows are rewritten and validated',
  );
  const legacyRewrite = migration.slice(legacyRewriteAt, validationAt);
  assert.match(legacyRewrite, /set\s+status = 'expired'/);
  assert.match(legacyRewrite, /'missing_self_attestation'/);
  assert.doesNotMatch(
    legacyRewrite,
    /set[\s\S]*declaration_version\s*=|set[\s\S]*self_attested_at\s*=/,
    'the upgrade must not synthesize consent evidence',
  );

  const recordStart = migration.indexOf(
    'affiliate_private.partners_service_fiscal_profile_record(',
  );
  const recordEnd = migration.indexOf(
    'affiliate_private.partners_service_payout_onboarding_get(',
    recordStart,
  );
  const record = migration.slice(recordStart, recordEnd);
  assert.match(record, /v_status not in \('pending', 'rejected', 'expired'\)/);
  assert.match(record, /direct service fiscal verification is forbidden/);
  assert.match(record, /pending fiscal self-attestation is required/);
  assert.doesNotMatch(record, /insert into affiliate_private\.affiliate_fiscal_profiles/);

  for (const [signature, operation] of [
    ['partners_service_fiscal_profile_self_attest(', 'fiscal_profile_self_attestation'],
    ['partners_service_payout_onboarding_request(', 'payout_onboarding'],
  ]) {
    const start = migration.indexOf(`affiliate_private.${signature}`);
    const end = migration.indexOf('\ncreate or replace function', start + 20);
    const rpc = migration.slice(start, end);
    const replay = rpc.indexOf('partners_replayed_response');
    const limiter = rpc.indexOf('partners_enforce_fiscal_onboarding_write_limit');
    assert.ok(replay >= 0, `${operation} retains terminal-response idempotency`);
    assert.equal(
      limiter,
      -1,
      `${operation} does not double-charge the separate Edge reservation`,
    );
    assert.match(rpc, new RegExp(`'${operation}'`));
  }
  const reservation = memberWriteRateMigration.toLowerCase();
  assert.match(reservation, /affiliate_member_write_reservations/);
  assert.match(reservation, /interval '30 days'/);
  assert.match(reservation, /interval '24 hours'/);
  assert.match(reservation, /v_limit constant integer := 8/);
  assert.match(reservation, /if found then[\s\S]*'replayed', true/);
  assert.match(reservation, /errcode = 'p0008'/);

  assert.match(migration, /partners_payout_account_evidence_is_current/);
  assert.match(migration, /route\.execution_adapter = 'revolut_manual'/);
  assert.match(migration, /fiscal_profile\.declaration_version =\s*'partners-tax-self-certification-v1'/);
  const bindingAuthorizationStart = migration.indexOf(
    'affiliate_private.admin_partners_revolut_beneficiary_binding_authorize_by_request(',
  );
  const bindingAuthorizationEnd = migration.indexOf(
    '\ncreate or replace function',
    bindingAuthorizationStart + 20,
  );
  const bindingAuthorization = migration.slice(
    bindingAuthorizationStart,
    bindingAuthorizationEnd,
  );
  assert.match(
    bindingAuthorization,
    /partners_payout_onboarding_allowed_currencies\([\s\S]*\)\s*@>\s*jsonb_build_array\(v_request\.currency\)/,
  );
  assert.doesNotMatch(
    bindingAuthorization,
    /v_request\.currency\s*=\s*any\s*\(\s*affiliate_private\.partners_payout_onboarding_allowed_currencies/,
    'the JSONB currency allowlist must not be passed to the SQL-array ANY operator',
  );
  assert.doesNotMatch(
    migration.slice(
      migration.indexOf('guard_payout_onboarding_request_transition()'),
      migration.indexOf('create trigger affiliate_payout_onboarding_requests_validate'),
    ),
    /old\.status = 'rejected' and new\.status = 'pending'/,
  );
  assert.match(
    migration,
    /revoke execute on function\s+public\.partners_service_payout_profile_set\(\s*uuid, text, text, text, text, text\s*\)\s+from service_role/,
  );
});

test('bootstrap data is copied through a strict schema and enum allowlist', () => {
  const { sanitizeBootstrapData } = helpers();
  const raw = validBootstrap();
  const clean = plain(sanitizeBootstrapData(raw, {
    countryCode: 'FR',
    subdivisionCode: 'FR-IDF',
  }));
  assert.deepEqual(clean, raw);

  const unknown = validBootstrap();
  unknown.provider_payload = { secret: true };
  assert.throws(() => sanitizeBootstrapData(unknown, {
    countryCode: 'FR',
    subdivisionCode: null,
  }));

  const business = validBootstrap();
  business.account = {
    exists: true,
    status: 'active',
    account_type: 'business',
    verification_status: 'verified',
    contract_status: 'accepted',
    link_status: 'active',
  };
  assert.throws(() => sanitizeBootstrapData(business, {
    countryCode: 'FR',
    subdivisionCode: null,
  }));

  const hiddenExtraState = validBootstrap();
  hiddenExtraState.account.status = 'approved_by_provider';
  hiddenExtraState.account.exists = true;
  hiddenExtraState.account.account_type = 'individual';
  hiddenExtraState.account.verification_status = 'verified';
  hiddenExtraState.account.contract_status = 'accepted';
  hiddenExtraState.account.link_status = 'active';
  assert.throws(() => sanitizeBootstrapData(hiddenExtraState, {
    countryCode: 'FR',
    subdivisionCode: null,
  }));

  for (const [field, value] of [
    ['commission_rate_bps', 1900],
    ['attribution_window_days', 31],
    ['maturation_days', 44],
  ]) {
    const driftedProgram = validBootstrap();
    driftedProgram.program[field] = value;
    assert.throws(() => sanitizeBootstrapData(driftedProgram, {
      countryCode: 'FR',
      subdivisionCode: null,
    }), `${field} must remain the P0 contractual value`);
  }

  const zeroThreshold = validBootstrap();
  zeroThreshold.program.payout_thresholds.EUR = 0;
  assert.throws(() => sanitizeBootstrapData(zeroThreshold, {
    countryCode: 'FR',
    subdivisionCode: null,
  }), 'every payout threshold must remain strictly positive');

  const missingThreshold = validBootstrap();
  missingThreshold.program.payout_thresholds = {};
  assert.throws(() => sanitizeBootstrapData(missingThreshold, {
    countryCode: 'FR',
    subdivisionCode: null,
  }), 'an active programme must expose at least one payout threshold');

  const missingUsdReference = validBootstrap();
  delete missingUsdReference.program.payout_thresholds.USD;
  assert.throws(() => sanitizeBootstrapData(missingUsdReference, {
    countryCode: 'FR',
    subdivisionCode: null,
  }), 'the programme must expose the immutable 10 USD reference threshold');

  const driftedUsdReference = validBootstrap();
  driftedUsdReference.program.payout_thresholds.USD = 999;
  assert.throws(() => sanitizeBootstrapData(driftedUsdReference, {
    countryCode: 'FR',
    subdivisionCode: null,
  }), 'the programme must fail closed when the USD reference drifts');

  const missingSettlementThreshold = validBootstrap();
  delete missingSettlementThreshold.program.payout_thresholds.EUR;
  assert.throws(() => sanitizeBootstrapData(missingSettlementThreshold, {
    countryCode: 'FR',
    subdivisionCode: null,
  }), 'every payout currency exposed by policy needs an exact threshold');

  const unsupportedKycLevel = validBootstrap();
  unsupportedKycLevel.policy.kyc_level = 'standard';
  assert.throws(() => sanitizeBootstrapData(unsupportedKycLevel, {
    countryCode: 'FR',
    subdivisionCode: null,
  }));
  const impossiblePolicyAge = validBootstrap();
  impossiblePolicyAge.policy.minimum_age = 100;
  assert.throws(() => sanitizeBootstrapData(impossiblePolicyAge, {
    countryCode: 'FR',
    subdivisionCode: null,
  }));

  const existingAccount = validBootstrap();
  existingAccount.visibility = { visible: true, reason: 'existing_account' };
  existingAccount.policy.country_code = 'US';
  existingAccount.policy.payout_currencies = ['USD'];
  existingAccount.account = {
    exists: true,
    status: 'active',
    account_type: 'individual',
    verification_status: 'verified',
    contract_status: 'accepted',
    link_status: 'active',
  };
  assert.doesNotThrow(() => sanitizeBootstrapData(existingAccount, {
    countryCode: 'FR',
    subdivisionCode: null,
  }), 'an existing account uses its stored jurisdiction, not the caller locale');
});

test('bootstrap fail-closes inconsistent null and eligibility states', () => {
  const { sanitizeBootstrapData } = helpers();
  const nonNullAbsentAccount = validBootstrap();
  nonNullAbsentAccount.account.link_status = 'none';
  assert.throws(() => sanitizeBootstrapData(nonNullAbsentAccount, {
    countryCode: 'FR',
    subdivisionCode: null,
  }));

  const noPolicy = validBootstrap();
  noPolicy.policy = null;
  assert.throws(() => sanitizeBootstrapData(noPolicy, {
    countryCode: 'FR',
    subdivisionCode: null,
  }));

  const disabledButEligible = validBootstrap();
  disabledButEligible.flags.partners_enabled = false;
  assert.throws(() => sanitizeBootstrapData(disabledButEligible, {
    countryCode: 'FR',
    subdivisionCode: null,
  }));

  const attentionWithoutAccount = validBootstrap();
  attentionWithoutAccount.eligibility = {
    eligible: false,
    reason: 'account_attention_required',
  };
  assert.throws(() => sanitizeBootstrapData(attentionWithoutAccount, {
    countryCode: 'FR',
    subdivisionCode: null,
  }));

  const blockedWithoutAccount = validBootstrap();
  blockedWithoutAccount.eligibility = {
    eligible: false,
    reason: 'account_blocked',
  };
  assert.throws(() => sanitizeBootstrapData(blockedWithoutAccount, {
    countryCode: 'FR',
    subdivisionCode: null,
  }));

  const existingReasonWithoutAccount = validBootstrap();
  existingReasonWithoutAccount.visibility = {
    visible: true,
    reason: 'existing_account',
  };
  assert.throws(() => sanitizeBootstrapData(existingReasonWithoutAccount, {
    countryCode: 'FR',
    subdivisionCode: null,
  }));

  const accountWithoutExistingReason = validBootstrap();
  accountWithoutExistingReason.account = {
    exists: true,
    status: 'active',
    account_type: 'individual',
    verification_status: 'verified',
    contract_status: 'accepted',
    link_status: 'none',
  };
  assert.throws(() => sanitizeBootstrapData(accountWithoutExistingReason, {
    countryCode: 'FR',
    subdivisionCode: null,
  }));

  const accountAttention = validBootstrap();
  accountAttention.visibility = { visible: true, reason: 'existing_account' };
  accountAttention.eligibility = {
    eligible: false,
    reason: 'account_attention_required',
  };
  accountAttention.account = {
    exists: true,
    status: 'active',
    account_type: 'individual',
    verification_status: 'verified',
    contract_status: 'accepted',
    link_status: 'none',
  };
  assert.doesNotThrow(() => sanitizeBootstrapData(accountAttention, {
    countryCode: 'FR',
    subdivisionCode: null,
  }));

  const invalidActiveLink = validBootstrap();
  invalidActiveLink.visibility = { visible: true, reason: 'existing_account' };
  invalidActiveLink.eligibility = { eligible: false, reason: 'account_blocked' };
  invalidActiveLink.account = {
    exists: true,
    status: 'held',
    account_type: 'individual',
    verification_status: 'verified',
    contract_status: 'accepted',
    link_status: 'active',
  };
  assert.throws(() => sanitizeBootstrapData(invalidActiveLink, {
    countryCode: 'FR',
    subdivisionCode: null,
  }));

  const mismatchedAllowlistMode = validBootstrap();
  mismatchedAllowlistMode.allowlist.required = false;
  assert.throws(() => sanitizeBootstrapData(mismatchedAllowlistMode, {
    countryCode: 'FR',
    subdivisionCode: null,
  }));

  const availableWhileDisabled = validBootstrap();
  availableWhileDisabled.flags.partners_enabled = false;
  availableWhileDisabled.eligibility = { eligible: false, reason: 'disabled' };
  assert.throws(() => sanitizeBootstrapData(availableWhileDisabled, {
    countryCode: 'FR',
    subdivisionCode: null,
  }));
});

test('member mutation and dashboard responses are copied through exact schemas', () => {
  const {
    sanitizeActivationReconcile,
    sanitizeDashboardData,
    sanitizeMutationData,
  } = helpers();
  const application = {
    schema_version: 1,
    action: 'application_submitted',
    replayed: false,
    account: validMemberAccount(),
    next_action: 'start_verification',
  };
  assert.deepEqual(
    plain(sanitizeMutationData(application, 'application_submitted')),
    application,
  );
  assert.throws(() => sanitizeMutationData({
    ...application,
    verification_reference: 'provider-secret',
  }, 'application_submitted'));

  const activeAccount = {
    exists: true,
    status: 'active',
    verification_status: 'verified',
    contract_status: 'accepted',
    link_status: 'active',
  };
  const rotated = {
    schema_version: 1,
    action: 'link_rotated',
    replayed: false,
    account: activeAccount,
    next_action: 'share_link',
    link: {
      status: 'active',
      share_url: 'https://norva.tv/r/AbCdEfGhIjKlMnOpQrStUvWxYz012345',
      rotated_at: '2026-07-29T12:02:00Z',
    },
  };
  assert.deepEqual(
    plain(sanitizeMutationData(rotated, 'link_rotated')),
    rotated,
  );
  for (const unsafeUrl of [
    'https://evil.example/r/AbCdEfGhIjKlMnOpQrStUvWxYz012345',
    'https://norva.tv/r/AbCdEfGhIjKlMnOpQrStUvWxYz012345?email=user@example.test',
    'https://norva.tv/app#partners',
  ]) {
    const unsafe = structuredClone(rotated);
    unsafe.link.share_url = unsafeUrl;
    assert.throws(() => sanitizeMutationData(unsafe, 'link_rotated'));
  }

  const activationPending = {
    schema_version: 1,
    action: 'activation_reconciled',
    changed: false,
    account: {
      exists: true,
      status: 'pending_verification',
      verification_status: 'verified',
      contract_status: 'accepted',
      link_status: 'none',
    },
    next_action: 'activate_account',
  };
  assert.deepEqual(
    plain(sanitizeActivationReconcile(activationPending)),
    activationPending,
  );
  const activationComplete = structuredClone(activationPending);
  activationComplete.changed = true;
  activationComplete.account.status = 'active';
  activationComplete.next_action = 'share_link';
  assert.deepEqual(
    plain(sanitizeActivationReconcile(activationComplete)),
    activationComplete,
  );
  const activationReplay = structuredClone(activationComplete);
  activationReplay.changed = false;
  assert.deepEqual(
    plain(sanitizeActivationReconcile(activationReplay)),
    activationReplay,
  );
  for (const contradictory of [
    { ...activationPending, changed: true },
    { ...activationPending, next_action: 'share_link' },
    { ...activationComplete, next_action: 'activate_account' },
    { ...activationPending, account_id: '385d8450-1111-4111-8111-111111111111' },
  ]) {
    assert.throws(() => sanitizeActivationReconcile(contradictory));
  }

  const dashboard = validDashboard('all');
  assert.deepEqual(
    plain(sanitizeDashboardData(dashboard, {
      historyLimit: 25,
      historyCursor: null,
      historyStatus: 'all',
    })),
    dashboard,
  );

  const noAccount = validDashboard();
  noAccount.account = {
    exists: false,
    status: null,
    verification_status: null,
    contract_status: null,
    link_status: null,
    country_code: null,
    subdivision_code: null,
    created_at: null,
    updated_at: null,
  };
  noAccount.history.items = [];
  noAccount.history.next_cursor = null;
  noAccount.reporting = {
    available: false,
    reason: 'no_financial_activity',
    currency: null,
    clicks: 0,
    referrals: 0,
    pending_minor: null,
    available_minor: null,
    paid_minor: null,
    currencies: [],
  };
  assert.deepEqual(
    plain(sanitizeDashboardData(noAccount, {
      historyLimit: 25,
      historyCursor: null,
      historyStatus: 'all',
    })),
    noAccount,
  );

  const multipleCurrencies = validDashboard();
  multipleCurrencies.reporting = {
    available: true,
    reason: 'multiple_currencies',
    currency: null,
    clicks: 18,
    referrals: 4,
    pending_minor: null,
    available_minor: null,
    paid_minor: null,
    currencies: [
      {
        currency: 'EUR',
        pending_minor: 1250,
        available_minor: 800,
        paid_minor: 2400,
        payout_destination_ready: false,
      },
      {
        currency: 'USD',
        pending_minor: 200,
        available_minor: 100,
        paid_minor: 50,
        payout_destination_ready: true,
      },
    ],
  };
  assert.deepEqual(
    plain(sanitizeDashboardData(multipleCurrencies, {
      historyLimit: 25,
      historyCursor: null,
      historyStatus: 'all',
    })),
    multipleCurrencies,
  );

  const inconsistentAvailability = validDashboard();
  inconsistentAvailability.reporting.available = false;
  inconsistentAvailability.reporting.reason = 'no_financial_activity';
  assert.throws(() => sanitizeDashboardData(inconsistentAvailability, {
    historyLimit: 25,
    historyCursor: null,
    historyStatus: 'all',
  }), 'unavailable reporting must not expose a currency or balances');

  const negativeCount = validDashboard();
  negativeCount.reporting.clicks = -1;
  assert.throws(() => sanitizeDashboardData(negativeCount, {
    historyLimit: 25,
    historyCursor: null,
    historyStatus: 'all',
  }), 'referral metrics must be non-negative safe integers');

  const filteredHistory = validDashboard('pending');
  assert.deepEqual(plain(sanitizeDashboardData(filteredHistory, {
    historyLimit: 25,
    historyCursor: null,
    historyStatus: 'pending',
  })), filteredHistory);

  const mismatchedFilteredHistory = validDashboard('pending');
  mismatchedFilteredHistory.history.items[0].type = 'commission_paid';
  assert.throws(() => sanitizeDashboardData(mismatchedFilteredHistory, {
    historyLimit: 25,
    historyCursor: null,
    historyStatus: 'pending',
  }), 'a filtered history must contain only its corresponding activity type');

  const tooManyRows = validDashboard();
  tooManyRows.history.items = Array.from({ length: 3 }, () => ({
    type: 'commission_pending',
    occurred_at: '2026-07-29T12:00:00Z',
  }));
  assert.throws(() => sanitizeDashboardData(tooManyRows, {
    historyLimit: 2,
    historyCursor: null,
    historyStatus: 'all',
  }));

  const rawPayload = validDashboard();
  rawPayload.history.items[0].provider_payload = { token: 'secret' };
  assert.throws(() => sanitizeDashboardData(rawPayload, {
    historyLimit: 25,
    historyCursor: null,
    historyStatus: 'all',
  }));
});

test('database failures map to public codes without parsing SQL messages', () => {
  const { mapDatabaseError } = helpers();
  assert.deepEqual(plain(mapDatabaseError({ code: '22023', message: 'raw SQL' })), {
    status: 400,
    code: 'invalid_query',
    message: 'The request parameters are invalid.',
  });
  assert.equal(mapDatabaseError({ code: 'P0002', message: 'user UUID here' }).code, 'invalid_access_token');
  assert.equal(mapDatabaseError({
    code: 'XX000',
    message: 'provider token and SQL payload',
  }).code, 'partners_temporarily_unavailable');
  assert.equal(
    mapDatabaseError({ code: '22023', message: 'raw SQL' }, 'mutation').code,
    'invalid_request',
  );
  assert.equal(mapDatabaseError({ code: 'P0003' }).code, 'idempotency_key_reused');
  assert.equal(mapDatabaseError({ code: 'P0004' }).code, 'request_in_progress');
  assert.equal(mapDatabaseError({ code: 'P0001' }).code, 'partners_action_not_allowed');
  assert.doesNotMatch(helperSource, /raw\.message|error\.message|details|hint/);
});

test('Edge routes derive identity only from verified JWT and scope every RPC explicitly', () => {
  assert.match(edgeSource, /verifyUserJwtLocally\(token\)/);
  assert.match(edgeSource, /db\.auth\.getUser\(token\)/);
  assert.match(edgeSource, /local === "fallback"/);
  for (const rpc of [
    'partners_service_bootstrap',
    'partners_service_apply',
    'partners_service_accept_terms',
    'partners_service_rotate_link',
    'partners_service_dashboard',
    'partners_service_fiscal_profile_get',
    'partners_service_fiscal_profile_self_attest',
    'partners_service_payout_onboarding_get',
    'partners_service_payout_onboarding_request',
  ]) {
    assert.match(helperSource, new RegExp(`"${rpc}"`), rpc);
  }
  assert.match(
    edgeSource,
    /callRpcWithClient\(admin, rpcName, args, requestKind\)/,
  );
  assert.match(edgeSource, /const \{ data, error \} = await db\.rpc\(rpcName, args\)/);
  assert.match(edgeSource, /p_user_id: userId/);
  assert.match(edgeSource, /p_country_code: query\.countryCode/);
  assert.match(edgeSource, /p_subdivision_code: query\.subdivisionCode/);
  assert.match(edgeSource, /p_account_type: input\.accountType/);
  assert.match(edgeSource, /p_idempotency_key: idempotencyKey/);
  assert.match(edgeSource, /p_history_limit: query\.historyLimit/);
  assert.doesNotMatch(edgeSource, /searchParams\.get\(["']user(?:Id|_id)["']\)/);
  assert.doesNotMatch(edgeSource, /body\.(?:userId|user_id)|input\.(?:userId|user_id)/);
  assert.doesNotMatch(edgeSource, /cloud_devices|device_token|service_role.*Authorization/i);
});

test('bootstrap RPC is service-only and returns exactly the schema sanitized by Edge', () => {
  const start = foundationMigration.indexOf(
    'create or replace function public.partners_service_bootstrap(',
  );
  const end = foundationMigration.indexOf(
    'grant execute on function public.partners_service_bootstrap',
    start,
  );
  assert.ok(start >= 0 && end > start, 'missing service bootstrap RPC');
  const rpc = foundationMigration.slice(start, end + 200);
  assert.match(rpc, /security definer\s+set search_path = ''/);
  assert.match(rpc, /p_user_id uuid/);
  assert.match(rpc, /p_country_code text default null/);
  assert.match(rpc, /p_subdivision_code text default null/);
  for (const key of [
    'schema_version',
    'flags',
    'visibility',
    'eligibility',
    'program',
    'policy',
    'allowlist',
    'account',
  ]) {
    assert.match(rpc, new RegExp(`'${key}'`));
  }
  assert.match(rpc, /revoke all on function public\.partners_service_bootstrap\(uuid, text, text\)[\s\S]*from public, anon, authenticated/);
  assert.match(foundationMigration, /grant execute on function public\.partners_service_bootstrap\(uuid, text, text\)\s+to service_role/);
  const returnedSnapshot = rpc.slice(rpc.indexOf('if v_program_exists then'));
  assert.doesNotMatch(
    returnedSnapshot,
    /verification_reference|verification_provider|user_pseudonym|public_code/,
    'private KYC/link identifiers may be checked internally but never serialized',
  );
});

test('Edge exposes only the bounded member routes and the versioned envelope', () => {
  for (const route of [
    '/bootstrap',
    '/applications',
    '/activate',
    '/activation/reconcile',
    '/links',
    '/dashboard',
    '/kyc/sessions',
    '/referral/claim',
    '/payout-profile',
    '/fiscal-profile',
    '/payout-onboarding',
  ]) {
    assert.match(helperSource, new RegExp(`route === "${route.replace('/', '\\/')}"`), route);
  }
  assert.match(edgeSource, /req\.method === "OPTIONS"/);
  assert.match(edgeSource, /allowedMethods\.includes\(req\.method\)/);
  assert.match(edgeSource, /version: PARTNERS_API_VERSION/);
  assert.match(helperSource, /PARTNERS_API_VERSION = "2026-07-29"/);
  assert.match(edgeSource, /sanitizeBootstrapData\(data, query\)/);
  assert.match(edgeSource, /sanitizeMutationData\(data, "application_submitted"\)/);
  assert.match(edgeSource, /sanitizeMutationData\(data, "terms_accepted"\)/);
  assert.match(edgeSource, /sanitizeActivationReconcile/);
  assert.match(edgeSource, /sanitizeMutationData\(data, "link_rotated"\)/);
  assert.match(edgeSource, /sanitizeDashboardData\(data, query\)/);
  assert.match(edgeSource, /parseIdempotencyKey/);
  assert.match(edgeSource, /new TextEncoder\(\)\.encode\(text\)\.byteLength > 4_096/);
  assert.doesNotMatch(edgeSource, /req\.json\(|req\.formData\(/);
});

test('Edge logging is bounded and never serializes identity, query or RPC errors', () => {
  const logging = edgeSource.slice(edgeSource.indexOf('function logOutcome'));
  const loggedObject = logging.slice(
    logging.indexOf('console[level]'),
    logging.indexOf('});', logging.indexOf('console[level]')) + 3,
  );
  assert.match(loggedObject, /correlationId/);
  assert.match(loggedObject, /route: safeRoute/);
  assert.match(loggedObject, /outcome/);
  assert.doesNotMatch(loggedObject, /userId|token|email|data|error|req\.url|searchParams/);
  assert.doesNotMatch(edgeSource, /console\.(?:log|info|warn|error)\([^)]*(?:token|userId|data|error)/s);
  assert.doesNotMatch(loggedObject, /URL|query|JWT|UUID|payload/i);
  assert.match(logging, /allowedMethodsForRoute\(route\) \? route : "\/unknown"/);
});

test('config documents why the gateway JWT gate is disabled', () => {
  assert.match(configSource, /\[functions\.norva-partners\]\nverify_jwt = false/);
  const marker = configSource.indexOf('[functions.norva-partners]');
  const section = configSource.slice(Math.max(0, marker - 700), marker + 100);
  assert.match(section, /OPTIONS preflights/);
  assert.match(section, /verifyUserJwtLocally/);
  assert.match(section, /device\/service tokens/);
});

test('contract clearly separates implemented user, referral and TV boundaries', () => {
  assert.match(contractSource, /`GET \/bootstrap`/);
  assert.match(contractSource, /`POST \/applications`/);
  assert.match(contractSource, /`POST \/activate`/);
  assert.match(contractSource, /`POST \/activation\/reconcile`/);
  assert.match(contractSource, /`POST \/links`/);
  assert.match(contractSource, /`GET \/dashboard`/);
  assert.match(contractSource, /business_accounts_not_supported/);
  assert.match(contractSource, /business_waitlist/);
  assert.match(contractSource, /kyc_billing_unavailable/);
  assert.match(contractSource, /Idempotency-Key/);
  assert.match(contractSource, /### Utilisateur/);
  assert.match(contractSource, /### Referral Web/);
  assert.match(contractSource, /### Appareil TV/);
  assert.match(contractSource, /"USD": 1000/);
  assert.match(contractSource, /seuil mondial de référence de\s+10,00 USD/i);
  assert.match(contractSource, /ne calculent pas eux-mêmes un équivalent FX/i);
});
