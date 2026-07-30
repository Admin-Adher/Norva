const test = require('node:test');
const assert = require('node:assert/strict');
const cryptoNode = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

if (!globalThis.crypto) globalThis.crypto = cryptoNode.webcrypto;

const root = path.resolve(__dirname, '..');
const read = (file) => fs
  .readFileSync(path.join(root, file), 'utf8')
  .replace(/\r\n/g, '\n');
let modulePromise;
function adapter() {
  modulePromise ??= import(pathToFileURL(
    path.join(
      root,
      'supabase/functions/_shared/partners-airwallex.mjs',
    ),
  ).href);
  return modulePromise;
}

function environment(overrides = {}) {
  const values = {
    NORVA_PARTNERS_PAYOUT_PROVIDER: 'airwallex',
    AIRWALLEX_ENVIRONMENT: 'sandbox',
    AIRWALLEX_CLIENT_ID: 'client_id_test',
    AIRWALLEX_API_KEY: 'api_key_test',
    AIRWALLEX_WEBHOOK_SECRET: 'webhook_secret_test',
    AIRWALLEX_TRANSFER_REASON: 'professional services',
    ...overrides,
  };
  return (name) => values[name];
}

function beneficiaryInput() {
  return {
    firstName: 'Jérémy',
    lastName: 'Hernandez',
    dateOfBirth: '1990-06-15',
    address: {
      city: 'Paris',
      countryCode: 'FR',
      postcode: '75001',
      state: 'Île-de-France',
      streetAddress: '1 rue de Rivoli',
    },
    bankDetails: {
      account_currency: 'EUR',
      account_name: 'Jérémy Hernandez',
      bank_country_code: 'FR',
      iban: 'FR7630006000011234567890189',
    },
    currency: 'EUR',
    transferMethod: 'LOCAL',
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('Airwallex configuration is off by default and fixed to official hosts/version', async () => {
  const { loadAirwallexConfig } = await adapter();
  assert.equal(loadAirwallexConfig(() => undefined), null);

  const sandbox = loadAirwallexConfig(environment());
  assert.equal(sandbox.baseUrl, 'https://api.sandbox.airwallex.com');
  assert.equal(sandbox.apiVersion, '2025-06-30');
  assert.equal(sandbox.timeoutMs, 7000);

  const production = loadAirwallexConfig(environment({
    AIRWALLEX_ENVIRONMENT: 'production',
  }));
  assert.equal(production.baseUrl, 'https://api.airwallex.com');

  assert.throws(
    () => loadAirwallexConfig(environment({ AIRWALLEX_API_KEY: '' })),
    /airwallex_not_configured/,
  );
  assert.throws(
    () => loadAirwallexConfig(environment({
      AIRWALLEX_API_VERSION: '2026-07-17',
    })),
    /airwallex_not_configured/,
  );
});

test('PERSONAL beneficiary payload is ephemeral and the public mask cannot expose IBAN', async () => {
  const {
    buildPersonalBeneficiaryRequest,
    parsePersonalBeneficiaryInput,
  } = await adapter();
  const input = parsePersonalBeneficiaryInput(beneficiaryInput());
  assert.equal(input.displayMasked, 'FR •••• 0189');
  assert.equal(input.displayMasked.includes('FR7630006'), false);

  const request = buildPersonalBeneficiaryRequest(
    input,
    'pbr_0123456789abcdef01234567',
  );
  assert.equal(request.beneficiary.entity_type, 'PERSONAL');
  assert.equal(request.beneficiary.type, 'BANK_ACCOUNT');
  assert.deepEqual(request.transfer_methods, ['LOCAL']);
  assert.equal(
    request.beneficiary.additional_info.external_identifier,
    'pbr_0123456789abcdef01234567',
  );
  assert.equal(request.beneficiary.bank_details.iban.endsWith('0189'), true);

  assert.throws(
    () => parsePersonalBeneficiaryInput({
      ...beneficiaryInput(),
      currency: 'USD',
    }),
    /invalid_bank_details/,
  );
  assert.throws(
    () => parsePersonalBeneficiaryInput({
      ...beneficiaryInput(),
      extra: 'not allowed',
    }),
    /invalid_request/,
  );
});

test('minor-unit conversion and transfer request preserve exact money and idempotency', async () => {
  const { buildTransferRequest, minorUnitsToDecimal } = await adapter();
  assert.equal(minorUnitsToDecimal(1, 2), '0.01');
  assert.equal(minorUnitsToDecimal('499', 2), '4.99');
  assert.equal(minorUnitsToDecimal(1000n, 0), '1000');
  assert.throws(() => minorUnitsToDecimal(0, 2), /invalid_transfer_amount/);

  const request = buildTransferRequest({
    key: 'pds_0123456789abcdef01234567',
    request_id: 'nv_0123456789abcdef0123456789abcdef',
    beneficiary_token_ref: '370d83d6-52e8-4bdd-97b6-56d18c5ba4d0',
    amount_minor: '499',
    currency_exponent: 2,
    currency: 'EUR',
    transfer_method: 'LOCAL',
  }, 'professional services');
  assert.deepEqual(request, {
    beneficiary_id: '370d83d6-52e8-4bdd-97b6-56d18c5ba4d0',
    reason: 'professional services',
    reference: 'NORVA-CDEF01234567',
    request_id: 'nv_0123456789abcdef0123456789abcdef',
    transfer_amount: '4.99',
    transfer_currency: 'EUR',
    transfer_method: 'LOCAL',
  });
});

test('Airwallex PAID is pending-capable and may advance to late FAILED', async () => {
  const {
    canAdvanceTransferState,
    canonicalTransferState,
  } = await adapter();
  assert.equal(canonicalTransferState('PAID'), 'PAID');
  assert.equal(canonicalTransferState('PAID', 'REVERSED'), 'REVERSED');
  assert.equal(canonicalTransferState('OVERDUE'), 'SCHEDULED');
  assert.equal(canAdvanceTransferState('SENT', 'PAID'), true);
  assert.equal(canAdvanceTransferState('PAID', 'FAILED'), true);
  assert.equal(canAdvanceTransferState('PAID', 'PROCESSING'), false);
  assert.equal(canAdvanceTransferState('REVERSED', 'PAID'), false);
  assert.throws(
    () => canonicalTransferState('MYSTERY'),
    /unknown_transfer_status/,
  );
});

test('webhook verification uses raw timestamp+body, a bounded clock and event allowlist', async () => {
  const {
    parseAirwallexTransferWebhook,
    verifyAirwallexWebhook,
  } = await adapter();
  const rawBody = JSON.stringify({
    id: 'evt_0123456789abcdef',
    name: 'payout.transfer.paid',
    data: { id: '370d83d6-52e8-4bdd-97b6-56d18c5ba4d0' },
  });
  const timestamp = '1785402720000';
  const secret = 'webhook_secret_test';
  const signature = cryptoNode
    .createHmac('sha256', secret)
    .update(timestamp + rawBody)
    .digest('hex');
  assert.equal(await verifyAirwallexWebhook({
    rawBody,
    timestamp,
    signature,
    secret,
    nowMs: Number(timestamp) + 1000,
    toleranceMs: 60_000,
  }), true);
  assert.equal(await verifyAirwallexWebhook({
    rawBody: `${rawBody} `,
    timestamp,
    signature,
    secret,
    nowMs: Number(timestamp) + 1000,
    toleranceMs: 60_000,
  }), false);
  assert.equal(await verifyAirwallexWebhook({
    rawBody,
    timestamp,
    signature,
    secret,
    nowMs: Number(timestamp) + 120_000,
    toleranceMs: 60_000,
  }), false);
  assert.deepEqual(parseAirwallexTransferWebhook(rawBody), {
    eventId: 'evt_0123456789abcdef',
    name: 'payout.transfer.paid',
    transferId: '370d83d6-52e8-4bdd-97b6-56d18c5ba4d0',
  });
  assert.throws(
    () => parseAirwallexTransferWebhook(JSON.stringify({
      id: 'evt_0123456789abcdef',
      name: 'payment_intent.succeeded',
      data: { id: '370d83d6-52e8-4bdd-97b6-56d18c5ba4d0' },
    })),
    /unsupported_webhook/,
  );
});

test('client caches login, sends no bank data back, and re-fetches ambiguous transfer by request_id', async () => {
  const {
    AirwallexClient,
    loadAirwallexConfig,
    parsePersonalBeneficiaryInput,
  } = await adapter();
  const calls = [];
  const fetchMock = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/authentication/login')) {
      return jsonResponse(201, {
        token: 'provider_access_token',
        expires_at: new Date(Date.now() + 25 * 60_000).toISOString(),
      });
    }
    if (url.endsWith('/beneficiaries/create')) {
      return jsonResponse(201, {
        id: '370d83d6-52e8-4bdd-97b6-56d18c5ba4d0',
        beneficiary: { entity_type: 'PERSONAL', type: 'BANK_ACCOUNT' },
        transfer_methods: ['LOCAL'],
      });
    }
    if (url.endsWith('/transfers/create')) {
      return jsonResponse(409, { code: 'request_pending' });
    }
    if (url.includes('/transfers?request_id=')) {
      return jsonResponse(200, {
        items: [{
          id: '470d83d6-52e8-4bdd-97b6-56d18c5ba4d1',
          request_id: 'nv_0123456789abcdef0123456789abcdef',
          transfer_amount: 4.99,
          transfer_currency: 'EUR',
          status: 'SCHEDULED',
          funding: { status: 'SCHEDULED' },
          updated_at: '2026-07-30T08:00:00Z',
        }],
      });
    }
    throw new Error(`unexpected ${url}`);
  };
  const client = new AirwallexClient(
    loadAirwallexConfig(environment()),
    fetchMock,
  );
  const input = parsePersonalBeneficiaryInput(beneficiaryInput());
  const created = await client.createPersonalBeneficiary(
    input,
    'pbr_0123456789abcdef01234567',
  );
  assert.deepEqual(created, {
    id: '370d83d6-52e8-4bdd-97b6-56d18c5ba4d0',
  });
  assert.equal(JSON.stringify(created).includes('FR7630006'), false);

  const transfer = await client.createTransfer({
    key: 'pds_0123456789abcdef01234567',
    request_id: 'nv_0123456789abcdef0123456789abcdef',
    beneficiary_token_ref: created.id,
    amount_minor: '499',
    currency_exponent: 2,
    currency: 'EUR',
    transfer_method: 'LOCAL',
  });
  assert.equal(transfer.state, 'SCHEDULED');
  assert.equal(
    calls.filter((call) => call.url.endsWith('/authentication/login')).length,
    1,
  );
  assert.equal(
    calls.some((call) =>
      call.url.includes('/transfers?request_id=') &&
      call.url.includes('page_size=2')
    ),
    true,
  );
});

test('Edge and SQL boundaries remain independently gated and PAID is not settled', () => {
  const edge = read(
    'supabase/functions/norva-partners-payout/index.ts',
  );
  const migration = read(
    'supabase/migrations/20260730073751_partners_airwallex_payout_adapter.sql',
  );
  const config = read('supabase/config.toml');
  const compose = read('ops/hetzner/docker-compose.supabase.yml');

  assert.match(edge, /verifyAirwallexWebhook\(/);
  assert.match(
    edge,
    /client\.getTransfer\(event\.transferId\)[\s\S]*partners_worker_airwallex_observation_record/,
  );
  assert.match(edge, /norva_verify_cron_secret/);
  assert.match(edge, /verifyUserJwtLocally/);
  assert.match(edge, /partners_service_airwallex_beneficiary_start/);
  assert.doesNotMatch(edge, /console\.(?:log|error)\([^)]*(?:bankDetails|rawBody|provider\.id)/);

  assert.match(
    migration,
    /where f\.key = 'partners_payouts_live'[\s\S]*payout_execution_adapter_verified/,
  );
  assert.match(
    migration,
    /cycle\.live_execution[\s\S]*cycle\.status in \('approved', 'submitted'\)/,
  );
  assert.match(
    migration,
    /provider_state <> 'PAID'[\s\S]*reconciliation_status in \('pending', 'confirmed', 'exception'\)/,
  );
  assert.doesNotMatch(
    migration,
    /when v_state = 'PAID'[\s\S]{0,500}status = 'settled'/,
  );
  assert.match(
    migration,
    /beneficiary_token_ref = excluded\.beneficiary_token_ref/,
  );
  assert.doesNotMatch(
    migration,
    /affiliate_(?:payout|airwallex)[a-z_]*\s*\([^;]*(?:iban|account_number)/i,
  );
  const executeGrants = [...migration.matchAll(
    /grant execute on function\s+([\s\S]*?)\s+to\s+([^;]+);/g,
  )];
  assert.equal(executeGrants.length, 16);
  assert.equal(
    executeGrants.every((grant) => grant[2].trim() === 'service_role'),
    true,
  );
  for (const functionName of [
    'partners_service_airwallex_beneficiary_prepare',
    'partners_service_airwallex_beneficiary_start',
    'partners_service_airwallex_beneficiary_record',
    'partners_service_airwallex_beneficiary_unknown',
    'partners_worker_airwallex_dispatch_lease',
    'partners_worker_airwallex_dispatch_retry',
    'partners_worker_airwallex_reconcile_lease',
    'partners_worker_airwallex_observation_record',
  ]) {
    assert.equal(
      executeGrants.filter((grant) => grant[1].includes(functionName)).length,
      2,
    );
  }
  assert.doesNotMatch(
    migration,
    /grant execute on function[\s\S]*?\bto\s+(?:anon|authenticated|public)\s*;/,
  );
  assert.match(
    config,
    /\[functions\.norva-partners-payout\]\nverify_jwt = false/,
  );
  assert.match(
    compose,
    /NORVA_PARTNERS_PAYOUT_PROVIDER: \$\{NORVA_PARTNERS_PAYOUT_PROVIDER:-\}/,
  );
});
