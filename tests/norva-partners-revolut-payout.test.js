'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cryptoNode = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

if (!globalThis.crypto) globalThis.crypto = cryptoNode.webcrypto;

const { privateKey: revolutTestPrivateKey } = cryptoNode.generateKeyPairSync(
  'rsa',
  {
    modulusLength: 2048,
    publicExponent: 0x10001,
  },
);
const revolutTestPrivateKeyPem = revolutTestPrivateKey.export({
  type: 'pkcs8',
  format: 'pem',
}).toString();

const root = path.resolve(__dirname, '..');
const read = (file) => fs
  .readFileSync(path.join(root, file), 'utf8')
  .replace(/\r\n/g, '\n');
const migrationPath =
  'supabase/migrations/20260730173351_partners_revolut_manual_hybrid.sql';

let businessPromise;
function business() {
  businessPromise ??= import(pathToFileURL(path.join(
    root,
    'supabase/functions/_shared/partners-revolut-business.mjs',
  )).href);
  return businessPromise;
}

let statementPromise;
function statement() {
  statementPromise ??= import(pathToFileURL(path.join(
    root,
    'supabase/functions/_shared/partners-revolut-statement.mjs',
  )).href);
  return statementPromise;
}

let beneficiaryPromise;
function beneficiary() {
  beneficiaryPromise ??= import(pathToFileURL(path.join(
    root,
    'supabase/functions/_shared/partners-revolut-beneficiary.mjs',
  )).href);
  return beneficiaryPromise;
}

function environment(overrides = {}) {
  const values = {
    NORVA_PARTNERS_REVOLUT_API_ENABLED: 'true',
    REVOLUT_BUSINESS_ENVIRONMENT: 'sandbox',
    REVOLUT_BUSINESS_REFRESH_TOKEN: 'oa_sandbox_refresh_token_test',
    REVOLUT_BUSINESS_CLIENT_ID: 'client_0123456789',
    REVOLUT_BUSINESS_ISSUER: 'norva.tv',
    REVOLUT_BUSINESS_PRIVATE_KEY_PEM: revolutTestPrivateKeyPem,
    REVOLUT_BUSINESS_SOURCE_ACCOUNTS_JSON: JSON.stringify({
      EUR: '2a0d4d03-e26c-4159-9de1-c6bf3adfd8a1',
    }),
    REVOLUT_BUSINESS_MAX_FEE_MINOR_JSON: JSON.stringify({ EUR: 100 }),
    ...overrides,
  };
  return { get: (name) => values[name] };
}

function withTestAccessToken(config) {
  return {
    ...config,
    initialAccessToken: 'oa_sandbox_access_token_test',
  };
}

function payoutJob(overrides = {}) {
  return {
    execution_key: 'rpx_0123456789abcdef01234567',
    request_id: '4016b891-bb50-4bd2-8a1b-adb74f4aacdd',
    reference: 'NORVA-A1B2C3D4E5F6',
    provider_transaction_id: null,
    beneficiary_token_ref: 'b53fdd78-8d67-4f63-a103-eeeeef53cac8',
    beneficiary_payment_method_ref:
      '5c9e171c-7e23-4d6a-b768-aaaaaba535f3',
    amount_minor: 499,
    currency: 'EUR',
    currency_exponent: 2,
    ...overrides,
  };
}

function transferFieldsResponse() {
  return jsonResponse(200, {
    fields: [
      {
        name: 'reference',
        required: true,
        validation: { max_length: 140 },
      },
      {
        name: 'charge_bearer',
        required: false,
        options: [
          { value: 'shared', default: true },
          { value: 'debtor' },
        ],
      },
    ],
  });
}

function indicativeQuoteResponse({
  amount = 4.99,
  fee = 0,
  total = amount + fee,
  currency = 'EUR',
} = {}) {
  return jsonResponse(200, {
    amount: { amount, currency },
    fee: { amount: fee, currency },
    estimated_total: { amount: total, currency },
  });
}

function transferDetail(overrides = {}) {
  return {
    id: 'transaction_0123456789',
    type: 'transfer',
    state: 'pending',
    request_id: payoutJob().request_id,
    reference: payoutJob().reference,
    legs: [{
      leg_id: 'leg_0123456789',
      account_id: '2a0d4d03-e26c-4159-9de1-c6bf3adfd8a1',
      counterparty: {
        account_id: '5c9e171c-7e23-4d6a-b768-aaaaaba535f3',
      },
      amount: -4.99,
      currency: 'EUR',
    }],
    ...overrides,
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(status, body) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain' },
  });
}

test('Revolut Business API is inert by default and accepts only official hosts', async () => {
  const {
    readRevolutBusinessConfig,
    revolutApiEnvironmentEnabled,
  } = await business();
  const off = { get: () => undefined };
  assert.equal(revolutApiEnvironmentEnabled(off), false);
  assert.equal(readRevolutBusinessConfig(off), null);
  const completeButDisabled = environment({
    NORVA_PARTNERS_REVOLUT_API_ENABLED: 'false',
  });
  assert.equal(revolutApiEnvironmentEnabled(completeButDisabled), false);
  assert.equal(readRevolutBusinessConfig(completeButDisabled), null);
  const completeButFlagMissing = environment({
    NORVA_PARTNERS_REVOLUT_API_ENABLED: undefined,
  });
  assert.equal(revolutApiEnvironmentEnabled(completeButFlagMissing), false);
  assert.equal(readRevolutBusinessConfig(completeButFlagMissing), null);
  assert.equal(
    revolutApiEnvironmentEnabled(environment({
      NORVA_PARTNERS_REVOLUT_API_ENABLED: 'TRUE',
    })),
    false,
  );

  const sandbox = readRevolutBusinessConfig(environment());
  assert.equal(
    sandbox.baseUrl,
    'https://sandbox-b2b.revolut.com/api/1.0',
  );
  const production = readRevolutBusinessConfig(environment({
    REVOLUT_BUSINESS_ENVIRONMENT: 'production',
  }));
  assert.equal(production.baseUrl, 'https://b2b.revolut.com/api/1.0');
  assert.throws(
    () => readRevolutBusinessConfig(environment({
      REVOLUT_BUSINESS_ENVIRONMENT: undefined,
    })),
    (error) => error?.code === 'revolut_business_not_configured',
  );
  assert.throws(
    () => readRevolutBusinessConfig(environment({
      REVOLUT_BUSINESS_MAX_FEE_MINOR_JSON: undefined,
    })),
    (error) => error?.code === 'revolut_business_not_configured',
  );
  assert.throws(
    () => readRevolutBusinessConfig(environment({
      REVOLUT_BUSINESS_MAX_FEE_MINOR_JSON: JSON.stringify({
        EUR: 100,
        USD: 100,
      }),
    })),
    (error) => error?.code === 'revolut_business_fee_caps_invalid',
  );
});

test('beneficiary fingerprints use versioned server-only HMAC keys', async () => {
  const {
    readRevolutBeneficiaryHmacConfig,
    signRevolutBeneficiaryFingerprint,
  } = await beneficiary();
  const key = cryptoNode.randomBytes(32).toString('base64url');
  const config = readRevolutBeneficiaryHmacConfig({
    get: (name) => ({
      NORVA_PARTNERS_REVOLUT_BENEFICIARY_HMAC_KEYS_JSON:
        JSON.stringify({ 7: key }),
      NORVA_PARTNERS_REVOLUT_BENEFICIARY_HMAC_ACTIVE_VERSION: '7',
    })[name],
  });
  const payload =
    'norva:partners:revolut-beneficiary-binding:v1|account|EUR|token';
  const first = await signRevolutBeneficiaryFingerprint(payload, 7, config);
  const replay = await signRevolutBeneficiaryFingerprint(payload, 7, config);
  const changed = await signRevolutBeneficiaryFingerprint(
    `${payload}|changed`,
    7,
    config,
  );

  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(config.activeVersion, 7);
  assert.equal(first, replay);
  assert.notEqual(first, changed);
  await assert.rejects(
    () => signRevolutBeneficiaryFingerprint(payload, 8, config),
    (error) => error?.code === 'beneficiary_hmac_key_unavailable',
  );
  assert.throws(
    () => readRevolutBeneficiaryHmacConfig({ get: () => undefined }),
    (error) => error?.code === 'beneficiary_hmac_not_configured',
  );
  assert.throws(
    () => readRevolutBeneficiaryHmacConfig({
      get: (name) => name ===
          'NORVA_PARTNERS_REVOLUT_BENEFICIARY_HMAC_KEYS_JSON'
        ? JSON.stringify({ 1: 'too-short' })
        : '1',
    }),
    (error) => error?.code === 'beneficiary_hmac_config_invalid',
  );
  assert.throws(
    () => readRevolutBeneficiaryHmacConfig({
      get: (name) => ({
        NORVA_PARTNERS_REVOLUT_BENEFICIARY_HMAC_KEYS_JSON:
          JSON.stringify({ 7: key }),
        NORVA_PARTNERS_REVOLUT_BENEFICIARY_HMAC_ACTIVE_VERSION: '6',
      })[name],
    }),
    (error) => error?.code === 'beneficiary_hmac_config_invalid',
  );
});

test('Revolut Business transfer validates fields, quotes, then pays with immutable reference', async () => {
  const {
    readRevolutBusinessConfig,
    RevolutBusinessClient,
  } = await business();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      body: init.body ? JSON.parse(init.body) : null,
      authorization: init.headers.Authorization,
    });
    if (url.endsWith('/pay/fields')) {
      return jsonResponse(200, {
        fields: [
          {
            name: 'reference',
            required: true,
            validation: {
              max_length: 140,
              regex: '^NORVA-[A-Z0-9]{12}$',
            },
          },
          {
            name: 'charge_bearer',
            required: false,
            options: [
              { value: 'shared', default: true },
              { value: 'debtor' },
            ],
          },
        ],
      });
    }
    if (url.endsWith('/pay/indicative-quote')) {
      return indicativeQuoteResponse();
    }
    if (url.endsWith('/transaction/transaction_0123456789')) {
      return jsonResponse(200, transferDetail());
    }
    return jsonResponse(200, {
      id: 'transaction_0123456789',
      state: 'pending',
      created_at: '2026-07-30T10:00:00.000Z',
    });
  };
  const client = new RevolutBusinessClient(
    withTestAccessToken(readRevolutBusinessConfig(environment({
      REVOLUT_BUSINESS_ENVIRONMENT: 'production',
    }))),
    fetchImpl,
  );
  const transaction = await client.createOrGetTransfer(payoutJob());

  assert.equal(transaction.state, 'PENDING');
  assert.deepEqual(calls.map((call) => call.url.split('/api/1.0')[1]), [
    '/pay/fields',
    '/pay/indicative-quote',
    '/pay',
    '/transaction/transaction_0123456789',
  ]);
  assert.equal(calls[2].body.reference, 'NORVA-A1B2C3D4E5F6');
  assert.equal(calls[2].body.amount, 4.99);
  assert.equal(calls[2].body.charge_bearer, 'debtor');
  assert.equal(
    calls[2].body.receiver.counterparty_id,
    'b53fdd78-8d67-4f63-a103-eeeeef53cac8',
  );
  assert.equal(
    calls[2].body.receiver.account_id,
    '5c9e171c-7e23-4d6a-b768-aaaaaba535f3',
  );
  assert.equal(calls[1].body.reference, undefined);
  assert.equal(calls[1].body.charge_bearer, 'debtor');
  assert.match(calls[2].authorization, /^Bearer /);
});

test('expired credentials refresh through a short-lived RS256 assertion', async () => {
  const {
    readRevolutBusinessConfig,
    RevolutBusinessClient,
  } = await business();
  const calls = [];
  const client = new RevolutBusinessClient(
    readRevolutBusinessConfig(environment()),
    async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/auth/token')) {
        return jsonResponse(200, {
          access_token: 'oa_sandbox_refreshed_access_token',
          token_type: 'bearer',
          expires_in: 2399,
        });
      }
      if (url.endsWith('/pay/fields')) {
        return transferFieldsResponse();
      }
      if (url.endsWith('/pay/indicative-quote')) {
        return indicativeQuoteResponse();
      }
      if (url.endsWith('/transaction/transaction_0123456789')) {
        return jsonResponse(200, transferDetail({ state: 'created' }));
      }
      return jsonResponse(200, {
        id: 'transaction_0123456789',
        state: 'created',
        created_at: '2026-07-30T10:00:00.000Z',
      });
    },
  );

  const transaction = await client.createOrGetTransfer(payoutJob());
  assert.equal(transaction.state, 'CREATED');
  assert.deepEqual(calls.map((call) => call.url.split('/api/1.0')[1]), [
    '/auth/token',
    '/pay/fields',
    '/pay/indicative-quote',
    '/pay',
    '/transaction/transaction_0123456789',
  ]);
  const oauthBody = new URLSearchParams(calls[0].init.body);
  assert.equal(oauthBody.get('grant_type'), 'refresh_token');
  assert.equal(
    oauthBody.get('client_assertion_type'),
    'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
  );
  assert.equal(oauthBody.get('client_assertion').split('.').length, 3);
  assert.equal(
    calls[1].init.headers.Authorization,
    'Bearer oa_sandbox_refreshed_access_token',
  );
});

test('a 401 refreshes once and a corridor with unknown required fields fails closed', async () => {
  const {
    readRevolutBusinessConfig,
    RevolutBusinessClient,
  } = await business();
  const calls = [];
  let fieldsAttempts = 0;
  const client = new RevolutBusinessClient(
    withTestAccessToken(readRevolutBusinessConfig(environment({
      REVOLUT_BUSINESS_ENVIRONMENT: 'production',
    }))),
    async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/auth/token')) {
        return jsonResponse(200, {
          access_token: 'oa_production_refreshed_access_token',
          expires_in: 2399,
        });
      }
      if (url.endsWith('/pay/fields')) {
        fieldsAttempts += 1;
        if (fieldsAttempts === 1) {
          return jsonResponse(401, { message: 'expired' });
        }
        return jsonResponse(200, {
          fields: [
            {
              name: 'reference',
              required: false,
              validation: { max_length: 100 },
            },
            {
              name: 'transfer_reason_code',
              required: true,
              options: [{ value: 'services' }],
            },
          ],
        });
      }
      throw new Error('payment must not be submitted');
    },
  );

  await assert.rejects(
    client.createOrGetTransfer(payoutJob()),
    (error) => (
      error?.code === 'revolut_business_corridor_fields_unconfigured'
    ),
  );
  assert.deepEqual(calls.map((call) => call.url.split('/api/1.0')[1]), [
    '/pay/fields',
    '/auth/token',
    '/pay/fields',
  ]);
  assert.equal(
    calls[2].init.headers.Authorization,
    'Bearer oa_production_refreshed_access_token',
  );
});

test('a corridor that can charge the beneficiary fails exact-money closed', async () => {
  const {
    readRevolutBusinessConfig,
    RevolutBusinessClient,
  } = await business();
  const calls = [];
  const client = new RevolutBusinessClient(
    withTestAccessToken(readRevolutBusinessConfig(environment({
      REVOLUT_BUSINESS_ENVIRONMENT: 'production',
    }))),
    async (url) => {
      calls.push(url);
      if (url.endsWith('/pay/fields')) {
        return jsonResponse(200, {
          fields: [
            {
              name: 'reference',
              required: true,
              validation: { max_length: 140 },
            },
            {
              name: 'charge_bearer',
              required: false,
              options: [{ value: 'shared', default: true }],
            },
          ],
        });
      }
      throw new Error('quote and payment must not be submitted');
    },
  );

  await assert.rejects(
    client.createOrGetTransfer(payoutJob()),
    (error) => (
      error?.code === 'revolut_business_exact_amount_not_supported' &&
      error?.retryable === false
    ),
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/pay\/fields$/);
});

test('indicative quote must attest exact units and stay under the Finance cap', async () => {
  const {
    readRevolutBusinessConfig,
    RevolutBusinessClient,
  } = await business();
  const cases = [
    {
      quote: { amount: 5, fee: 0, total: 5 },
      code: 'revolut_business_quote_invalid',
    },
    {
      quote: { amount: 4.99, fee: 0.1, total: 5.08 },
      code: 'revolut_business_quote_invalid',
    },
    {
      quote: { amount: 4.99, fee: 0, total: 4.99, currency: 'USD' },
      code: 'revolut_business_quote_invalid',
    },
    {
      quote: { amount: 4.99, fee: 1.01, total: 6 },
      code: 'revolut_business_fee_limit_exceeded',
    },
  ];
  for (const fixture of cases) {
    const paths = [];
    const client = new RevolutBusinessClient(
      withTestAccessToken(readRevolutBusinessConfig(environment())),
      async (url) => {
        paths.push(new URL(url).pathname);
        if (url.endsWith('/pay/fields')) return transferFieldsResponse();
        if (url.endsWith('/pay/indicative-quote')) {
          return indicativeQuoteResponse(fixture.quote);
        }
        throw new Error('payment must not be submitted');
      },
    );
    await assert.rejects(
      client.createOrGetTransfer(payoutJob()),
      (error) => error?.code === fixture.code && error?.retryable === false,
    );
    assert.equal(paths.some((value) => value.endsWith('/pay')), false);
  }
});

test('existing Revolut transaction is polled and never submitted twice', async () => {
  const {
    readRevolutBusinessConfig,
    RevolutBusinessClient,
  } = await business();
  const calls = [];
  const client = new RevolutBusinessClient(
    withTestAccessToken(readRevolutBusinessConfig(environment())),
    async (url, init) => {
      calls.push({ url, method: init.method });
      return jsonResponse(200, transferDetail({ state: 'completed' }));
    },
  );
  const result = await client.createOrGetTransfer(payoutJob({
    provider_transaction_id: 'transaction_0123456789',
  }));
  assert.equal(result.state, 'COMPLETED');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/transaction\/transaction_0123456789$/);
  assert.equal(calls[0].method, 'GET');
});

test('transaction detail must attest the exact Norva transfer before observation', async () => {
  const {
    readRevolutBusinessConfig,
    RevolutBusinessClient,
  } = await business();
  const invalidDetails = [
    transferDetail({ type: 'card_payment' }),
    transferDetail({ request_id: '760d7398-7926-4469-b657-ce3b4be50af0' }),
    transferDetail({ reference: 'NORVA-000000000000' }),
    transferDetail({
      legs: [{
        account_id: 'be2443a8-504e-40a8-ac3a-eb6085232ae2',
        amount: -4.99,
        currency: 'EUR',
      }],
    }),
    transferDetail({
      legs: [{
        account_id: '2a0d4d03-e26c-4159-9de1-c6bf3adfd8a1',
        amount: -5,
        currency: 'EUR',
      }],
    }),
    transferDetail({
      legs: [{
        account_id: '2a0d4d03-e26c-4159-9de1-c6bf3adfd8a1',
        amount: -4.99,
        currency: 'USD',
      }],
    }),
    transferDetail({
      receiver: {
        counterparty_id: '5aa88904-5f1a-4fdd-805d-c7c5f2968294',
      },
    }),
    transferDetail({
      receiver: {
        account_id: '2a4fd2fa-f668-458b-82f0-8fba8732d754',
      },
    }),
  ];

  for (const detail of invalidDetails) {
    const client = new RevolutBusinessClient(
      withTestAccessToken(readRevolutBusinessConfig(environment())),
      async (url) => {
        assert.match(url, /\/transaction\/transaction_0123456789$/);
        return jsonResponse(200, detail);
      },
    );
    await assert.rejects(
      client.createOrGetTransfer(payoutJob({
        provider_transaction_id: 'transaction_0123456789',
      })),
      (error) => (
        error?.code === 'revolut_business_transaction_mismatch' &&
        error?.retryable === false
      ),
    );
  }
});

test('an ambiguous pay response is recovered by the immutable request id', async () => {
  const {
    readRevolutBusinessConfig,
    RevolutBusinessClient,
  } = await business();
  const paths = [];
  const client = new RevolutBusinessClient(
    withTestAccessToken(readRevolutBusinessConfig(environment())),
    async (url) => {
      const parsed = new URL(url);
      paths.push(`${parsed.pathname}${parsed.search}`);
      if (parsed.pathname.endsWith('/pay/fields')) {
        return transferFieldsResponse();
      }
      if (parsed.pathname.endsWith('/pay/indicative-quote')) {
        return indicativeQuoteResponse();
      }
      if (parsed.pathname.endsWith('/pay')) {
        return jsonResponse(409, { message: 'duplicate request id' });
      }
      if (parsed.pathname.endsWith('/transaction/transaction_0123456789')) {
        return jsonResponse(200, transferDetail());
      }
      assert.equal(
        parsed.searchParams.get('request_id'),
        payoutJob().request_id,
      );
      assert.equal(parsed.searchParams.get('count'), '10');
      return jsonResponse(200, [{
        id: 'transaction_0123456789',
        type: 'transfer',
        state: 'pending',
        request_id: payoutJob().request_id,
      }]);
    },
  );

  const result = await client.createOrGetTransfer(payoutJob());
  assert.equal(result.state, 'PENDING');
  assert.equal(paths.filter((value) => value.endsWith('/pay')).length, 1);
  assert.equal(paths.some((value) => /\/transactions\?/.test(value)), true);
  assert.match(paths.at(-1), /\/transaction\/transaction_0123456789$/);
});

test('a malformed successful pay response is recovered without changing request id', async () => {
  const {
    readRevolutBusinessConfig,
    RevolutBusinessClient,
  } = await business();
  const calls = [];
  const client = new RevolutBusinessClient(
    withTestAccessToken(readRevolutBusinessConfig(environment())),
    async (url, init) => {
      const parsed = new URL(url);
      calls.push({
        path: `${parsed.pathname}${parsed.search}`,
        body: init.body ? JSON.parse(init.body) : null,
      });
      if (parsed.pathname.endsWith('/pay/fields')) {
        return transferFieldsResponse();
      }
      if (parsed.pathname.endsWith('/pay/indicative-quote')) {
        return indicativeQuoteResponse();
      }
      if (parsed.pathname.endsWith('/pay')) {
        return textResponse(200, 'accepted upstream without JSON');
      }
      if (parsed.pathname.endsWith('/transaction/transaction_0123456789')) {
        return jsonResponse(200, transferDetail({ state: 'processing' }));
      }
      assert.equal(
        parsed.searchParams.get('request_id'),
        payoutJob().request_id,
      );
      return jsonResponse(200, [{
        id: 'transaction_0123456789',
        type: 'transfer',
        state: 'processing',
        request_id: payoutJob().request_id,
      }]);
    },
  );

  const result = await client.createOrGetTransfer(payoutJob());
  assert.equal(result.state, 'PROCESSING');
  assert.equal(
    calls.find((call) => call.path.endsWith('/pay')).body.request_id,
    payoutJob().request_id,
  );
  assert.equal(calls.filter((call) => call.path.endsWith('/pay')).length, 1);
  assert.equal(
    calls.some((call) => /\/transactions\?/.test(call.path)),
    true,
  );
  assert.match(
    calls.at(-1).path,
    /\/transaction\/transaction_0123456789$/,
  );
});

test('a non-JSON 429 pay response remains retryable and is reconciled first', async () => {
  const {
    readRevolutBusinessConfig,
    RevolutBusinessClient,
  } = await business();
  const paths = [];
  const client = new RevolutBusinessClient(
    withTestAccessToken(readRevolutBusinessConfig(environment())),
    async (url) => {
      const parsed = new URL(url);
      paths.push(`${parsed.pathname}${parsed.search}`);
      if (parsed.pathname.endsWith('/pay/fields')) {
        return transferFieldsResponse();
      }
      if (parsed.pathname.endsWith('/pay/indicative-quote')) {
        return indicativeQuoteResponse();
      }
      if (parsed.pathname.endsWith('/pay')) {
        return textResponse(429, 'rate limited');
      }
      if (parsed.pathname.endsWith('/transaction/transaction_0123456789')) {
        return jsonResponse(200, transferDetail());
      }
      return jsonResponse(200, [{
        id: 'transaction_0123456789',
        type: 'transfer',
        state: 'pending',
        request_id: payoutJob().request_id,
      }]);
    },
  );

  const result = await client.createOrGetTransfer(payoutJob());
  assert.equal(result.state, 'PENDING');
  assert.equal(paths.filter((value) => value.endsWith('/pay')).length, 1);
  assert.equal(paths.some((value) => /\/transactions\?/.test(value)), true);
  assert.match(paths.at(-1), /\/transaction\/transaction_0123456789$/);
});

test('a non-JSON OAuth rate limit is classified as retryable', async () => {
  const {
    readRevolutBusinessConfig,
    RevolutBusinessClient,
  } = await business();
  const client = new RevolutBusinessClient(
    readRevolutBusinessConfig(environment()),
    async (url) => {
      assert.match(url, /\/auth\/token$/);
      return textResponse(429, 'rate limited');
    },
  );

  await assert.rejects(
    client.createOrGetTransfer(payoutJob()),
    (error) => (
      error?.code === 'revolut_business_oauth_http_429' &&
      error?.retryable === true
    ),
  );
});

test('official Revolut webhook signature vector is verified in constant time', async () => {
  const { revolutWebhookSignatureMatches } = await business();
  const rawBody =
    '{"data":{"id":"645a7696-22f3-aa47-9c74-cbae0449cc46","new_state":"completed","old_state":"pending","request_id":"app_charges-9f5d5eb3-1e06-46c5-b1c0-3914763e0bcb"},"event":"TransactionStateChanged","timestamp":"2023-05-09T16:36:38.028960Z"}';
  const input = {
    rawBody,
    timestamp: '1683650202360',
    signatureHeader:
      'v1=bca326fb378d0da7f7c490ad584a8106bab9723d8d9cdd0d50b4c5b3be3837c0',
    signingSecret: 'wsk_r59a4HfWVAKycbCaNO1RvgCJec02gRd8',
    now: 1683650202360,
  };
  assert.equal(await revolutWebhookSignatureMatches(input), true);
  assert.equal(await revolutWebhookSignatureMatches({
    ...input,
    rawBody: `${rawBody} `,
  }), false);
});

test('statement parser keeps only Norva rows and normalizes outgoing amounts', async () => {
  const { normalizeRevolutStatementCsv } = await statement();
  const csv = [
    'Date completed (UTC),ID,State,Reference,Payment currency,Amount,Extra',
    '2026-07-29,transaction_ignored,COMPLETED,Groceries,EUR,-12.00,private',
    '30/07/2026,transaction_0123456789,COMPLETED,NORVA-A1B2C3D4E5F6,EUR,-4.99,private',
  ].join('\r\n');
  const normalized = await normalizeRevolutStatementCsv(csv, { EUR: 2 });
  assert.equal(normalized.ignoredRowCount, 1);
  assert.equal(normalized.groups.length, 1);
  assert.deepEqual(normalized.groups[0].rows, [{
    reference: 'NORVA-A1B2C3D4E5F6',
    provider_transaction_id: 'transaction_0123456789',
    amount_minor: 499,
    currency: 'EUR',
    value_date: '2026-07-30',
    provider_state: 'completed',
  }]);
  assert.match(normalized.sourceFileHash, /^[0-9a-f]{64}$/);
});

test('statement parser preserves non-completed Norva states for review', async () => {
  const { normalizeRevolutStatementCsv } = await statement();
  const csv = [
    'Date completed (UTC),ID,State,Reference,Payment currency,Amount',
    '2026-07-30,transaction_0123456789,REVERTED,NORVA-A1B2C3D4E5F6,EUR,-4.99',
  ].join('\r\n');
  const normalized = await normalizeRevolutStatementCsv(csv, { EUR: 2 });
  assert.equal(normalized.groups[0].rows[0].provider_state, 'reverted');
});

test('statement parser maps English and French declines to the SQL failed state', async () => {
  const { normalizeRevolutStatementCsv } = await statement();
  for (const providerState of ['DECLINED', 'REFUSÉ']) {
    const csv = [
      'Date completed (UTC),ID,State,Reference,Payment currency,Amount',
      `2026-07-30,transaction_0123456789,${providerState},NORVA-A1B2C3D4E5F6,EUR,-4.99`,
    ].join('\r\n');
    const normalized = await normalizeRevolutStatementCsv(csv, { EUR: 2 });
    assert.equal(normalized.groups[0].rows[0].provider_state, 'failed');
  }
});

test('statement parser enforces the SQL maximum of 5000 Norva rows', async () => {
  const { normalizeRevolutStatementCsv } = await statement();
  const header =
    'Date completed (UTC),ID,State,Reference,Payment currency,Amount';
  const rows = Array.from({ length: 5001 }, (_, index) => {
    const suffix = index.toString(16).toUpperCase().padStart(12, '0');
    return `2026-07-30,transaction_${index.toString().padStart(8, '0')},COMPLETED,NORVA-${suffix},EUR,-4.99`;
  });
  await assert.rejects(
    normalizeRevolutStatementCsv([header, ...rows].join('\n'), { EUR: 2 }),
    (error) => error?.code === 'revolut_statement_too_many_norva_rows',
  );
});

test('statement parser rejects an incoming amount as payout evidence', async () => {
  const { normalizeRevolutStatementCsv } = await statement();
  const csv = [
    'Date completed (UTC),ID,State,Reference,Payment currency,Amount',
    '2026-07-30,transaction_0123456789,COMPLETED,NORVA-A1B2C3D4E5F6,EUR,4.99',
  ].join('\r\n');
  await assert.rejects(
    normalizeRevolutStatementCsv(csv, { EUR: 2 }),
    (error) => error?.code === 'revolut_statement_amount_direction_invalid',
  );
});

test('statement parser detects comma, semicolon or tab and rejects unknown layouts', async () => {
  const { normalizeRevolutStatementCsv } = await statement();
  const semicolon = [
    'Date de fin (UTC);Identifiant de transaction;Statut;Référence de paiement;Devise de paiement;Montant',
    '30/07/2026;transaction_0123456789;TERMINÉ;NORVA-A1B2C3D4E5F6;EUR;-4,99',
  ].join('\r\n');
  const tab = [
    [
      'Date completed (UTC)',
      'ID',
      'State',
      'Reference',
      'Payment currency',
      'Amount',
    ].join('\t'),
    [
      '2026-07-30',
      'transaction_0123456789',
      'COMPLETED',
      'NORVA-A1B2C3D4E5F6',
      'EUR',
      '-4.99',
    ].join('\t'),
  ].join('\r\n');

  for (const value of [semicolon, tab]) {
    const normalized = await normalizeRevolutStatementCsv(value, { EUR: 2 });
    assert.equal(normalized.groups[0].rows[0].amount_minor, 499);
  }
  await assert.rejects(
    normalizeRevolutStatementCsv(
      [
        'Date completed (UTC)|ID|State|Reference|Payment currency|Amount',
        '2026-07-30|transaction_0123456789|COMPLETED|NORVA-A1B2C3D4E5F6|EUR|-4.99',
      ].join('\r\n'),
      { EUR: 2 },
    ),
    (error) => error?.code === 'revolut_statement_delimiter_invalid',
  );
});

test('manual batch CSV is deterministic and neutralizes spreadsheet formulas', async () => {
  const { buildRevolutManualBatchCsv } = await statement();
  const csv = buildRevolutManualBatchCsv({
    batch: { key: 'rmb_0123456789abcdef01234567' },
    items: [{
      beneficiary_token_ref: '=counterparty_012345',
      destination_masked: '+Jeremy EUR beneficiary',
      amount_minor: 499,
      currency: 'EUR',
      currency_exponent: 2,
      reference: 'NORVA-A1B2C3D4E5F6',
    }],
  });
  assert.match(csv, /'=counterparty_012345/);
  assert.match(csv, /'\+Jeremy EUR beneficiary/);
  assert.match(csv, /4\.99,EUR,NORVA-A1B2C3D4E5F6/);
});

test('migration installs exact-money manual batches and a double-gated API rail', () => {
  const sql = read(migrationPath);
  assert.match(sql, /partners_revolut_api_enabled[\s\S]*false/i);
  assert.match(sql, /manual_payout_workflow_verified/);
  assert.match(sql, /revolut_api_adapter_verified/);
  assert.match(
    sql,
    /status <> 'active'[\s\S]*provider = 'revolut'[\s\S]*revolut_manual[\s\S]*revolut_api/i,
  );
  assert.match(
    sql,
    /create table affiliate_private\.affiliate_revolut_manual_batches/i,
  );
  assert.match(
    sql,
    /create table affiliate_private\.affiliate_revolut_payout_executions/i,
  );
  assert.match(sql, /payout_reference\s+text not null unique/i);
  assert.match(sql, /\^NORVA-\[A-F0-9\]\{12\}\$/);
  assert.match(sql, /partner_payout_clearing'[\s\S]*'debit'/);
  assert.match(sql, /partner_cash_settled'[\s\S]*'credit'/);
  assert.match(sql, /review and decision require distinct Finance actors/);
  assert.match(sql, /for update of execution skip locked/i);
  assert.match(sql, /revolut_api_disabled[\s\S]*'jobs', '\[\]'::jsonb/i);
  for (const [routine, signature] of [
    ['partners_worker_revolut_global_lease_acquire', 'text, text, integer'],
    ['partners_worker_revolut_global_lease_renew', 'text, text, bigint, integer'],
    ['partners_worker_revolut_global_lease_release', 'text, text, bigint'],
    ['partners_worker_revolut_payout_lease', 'text, text, bigint, integer, integer'],
    ['partners_worker_revolut_payout_retry', 'text, text, text, bigint, text, boolean'],
    [
      'partners_worker_revolut_payout_observe',
      'text, text, text, text, timestamptz, text, text, bigint',
    ],
  ]) {
    const normalized = signature
      .split(', ')
      .map((type) => `${type}\\s*`)
      .join(',\\s*');
    assert.match(
      sql,
      new RegExp(
        `grant execute on function\\s+affiliate_private\\.${routine}\\(\\s*${normalized}\\)\\s*to service_role`,
        'i',
      ),
    );
    assert.match(
      sql,
      new RegExp(
        `grant execute on function\\s+public\\.${routine}\\(\\s*${normalized}\\)\\s*to service_role`,
        'i',
      ),
    );
  }
  assert.doesNotMatch(
    sql,
    /create table[\s\S]{0,200}\b(?:iban|account_number|beneficiary_name)\b/i,
  );
});

test('Revolut references use a durable collision-safe 12-hex allocation', () => {
  const sql = read(migrationPath);
  assert.match(
    sql,
    /create table affiliate_private\.affiliate_revolut_reference_allocations/i,
  );
  assert.match(
    sql,
    /affiliate_private\.allocate_revolut_payout_reference\(\s*p_payout_item_id uuid\s*\)/i,
  );
  assert.match(sql, /for v_attempt in 1\.\.32 loop/i);
  assert.match(
    sql,
    /'NORVA-' \|\| upper\(encode\(\s*extensions\.gen_random_bytes\(6\)/i,
  );
  assert.match(
    sql,
    /foreign key \(payout_item_id, payout_reference\)[\s\S]*affiliate_revolut_reference_allocations/i,
  );
  assert.doesNotMatch(sql, /NORVA-\[A-F0-9\]\{20\}/);
});

test('API polling keeps paid transfers observable until Finance reconciliation', () => {
  const sql = read(migrationPath);
  const leaseStart = sql.indexOf(
    'affiliate_private.partners_worker_revolut_payout_lease(',
  );
  const retryStart = sql.indexOf(
    'affiliate_private.partners_worker_revolut_payout_retry(',
    leaseStart,
  );
  assert.ok(leaseStart >= 0 && retryStart > leaseStart);
  const lease = sql.slice(leaseStart, retryStart);
  assert.match(
    lease,
    /execution\.state = 'paid'[\s\S]*execution\.reconciliation_status in \('not_ready', 'pending'\)/i,
  );
  assert.match(
    lease,
    /execution\.paid_observed_at >=\s*now\(\) - interval '90 days'/i,
  );
  assert.match(
    lease,
    /order by[\s\S]*case when execution\.state = 'paid' then 1 else 0 end/i,
  );
});

test('statement imports require an AAL2 one-use ticket at the service boundary', () => {
  const sql = read(migrationPath);
  const edge = read(
    'supabase/functions/norva-partners-revolut-payout/index.ts',
  );
  assert.match(
    sql,
    /create table affiliate_private\.affiliate_revolut_statement_tickets/i,
  );
  assert.match(
    sql,
    /ticket_token_hash\s+text not null unique[\s\S]*expires_at\s+timestamptz not null[\s\S]*consumed_at\s+timestamptz/i,
  );
  assert.match(
    sql,
    /admin_partners_revolut_statement_authorize\(\)[\s\S]*partners_require_capability\('finance'\)[\s\S]*auth\.jwt\(\) ->> 'aal'[\s\S]*'aal2'[\s\S]*gen_random_bytes\(32\)[\s\S]*digest\(v_token, 'sha256'\)/i,
  );
  assert.match(
    sql,
    /affiliate_private\.partners_service_revolut_statement_ingest\(\s*p_source_file_hash text,\s*p_period_start date,\s*p_period_end date,\s*p_currency text,\s*p_rows jsonb,\s*p_worker_id text,\s*p_import_ticket text\s*\)/i,
  );
  assert.match(
    sql,
    /where ticket\.ticket_token_hash = v_ticket_hash\s*for update[\s\S]*consumed_at = now\(\),\s*source_file_hash = v_file_hash[\s\S]*ticket\.consumed_at is null/i,
  );
  assert.match(
    sql,
    /grant execute on function\s+public\.partners_service_revolut_statement_ingest\(\s*text,\s*date,\s*date,\s*text,\s*jsonb,\s*text,\s*text\s*\)\s*to service_role/i,
  );
  assert.match(
    sql,
    /Direct statement ingestion is disabled; use the trusted Edge parser/i,
  );
  assert.match(edge, /const importTicket = String\(authorization\.import_ticket/);
  assert.match(edge, /\/\^\[0-9a-f\]\{64\}\$\/\.test\(importTicket\)/);
  assert.match(edge, /p_import_ticket: importTicket/);
  assert.match(
    edge,
    /normalizeRevolutStatementCsv[\s\S]*admin_partners_revolut_statement_authorize[\s\S]*partners_service_revolut_statement_ingest/,
  );
});

test('client-supplied Revolut beneficiary tokens are rejected by both boundaries', () => {
  const edge = read('supabase/functions/_shared/partners-payout.ts');
  const web = read('public/js/cloudApi.js');
  const trustedBoundary = read(
    'supabase/functions/norva-partners-revolut-payout/index.ts',
  );
  const edgeWriteList = edge.slice(
    edge.indexOf('const CLIENT_SUPPLIED_PROVIDERS'),
    edge.indexOf('const ACCOUNT_STATUSES'),
  );
  const webWriteList = web.slice(
    web.indexOf('const PARTNERS_PAYOUT_TOKEN_WRITE_PROVIDERS'),
    web.indexOf('const PARTNERS_PAYOUT_PROFILE_STATUSES'),
  );
  assert.doesNotMatch(edgeWriteList, /"revolut"/);
  assert.doesNotMatch(webWriteList, /'revolut'/);
  assert.match(
    trustedBoundary,
    /\/manual\/beneficiaries\/propose/,
  );
  assert.match(
    trustedBoundary,
    /admin_partners_revolut_beneficiary_binding_authorize/,
  );
  assert.match(
    trustedBoundary,
    /signRevolutBeneficiaryFingerprint[\s\S]*partners_service_revolut_beneficiary_binding_propose/,
  );
  assert.match(
    trustedBoundary,
    /authorization\.attestation_payload[\s\S]*p_mapping_attestation_hmac:\s*attestation/,
  );
  assert.doesNotMatch(
    trustedBoundary,
    /console\.(?:log|error)\([^)]*(?:beneficiaryTokenRef|fingerprintPayload|ticket)/,
  );
});

test('Edge and ops contracts keep Revolut API off by default', () => {
  const edge = read(
    'supabase/functions/norva-partners-revolut-payout/index.ts',
  );
  const businessClient = read(
    'supabase/functions/_shared/partners-revolut-business.mjs',
  );
  const compose = read('ops/hetzner/docker-compose.supabase.yml');
  const envExample = read('ops/hetzner/.env.hetzner.example');
  const parity = read('ops/hetzner/scripts/05-verify-parity.sh');
  const config = read('supabase/config.toml');
  assert.match(edge, /revolutApiEnvironmentEnabled/);
  assert.match(edge, /partners_worker_revolut_global_lease_acquire/);
  assert.match(edge, /partners_worker_revolut_global_lease_renew/);
  assert.match(edge, /partners_worker_revolut_global_lease_release/);
  assert.match(edge, /partners_worker_revolut_payout_lease/);
  assert.match(edge, /p_global_lease_generation: generation/);
  assert.match(edge, /p_retryable: providerErrorRetryable\(error\)/);
  assert.match(edge, /admin_partners_revolut_statement_authorize/);
  assert.match(edge, /admin_partners_revolut_statement_context/);
  assert.match(edge, /partners_service_revolut_statement_ingest/);
  assert.match(edge, /readJsonBody\(req, 10_100_000\)/);
  assert.doesNotMatch(edge, /body\.currencyExponents/);
  assert.match(
    compose,
    /NORVA_PARTNERS_REVOLUT_API_ENABLED: \$\{NORVA_PARTNERS_REVOLUT_API_ENABLED:-false\}/,
  );
  assert.match(
    compose,
    /NORVA_PARTNERS_REVOLUT_API_BATCH: \$\{NORVA_PARTNERS_REVOLUT_API_BATCH:-1\}/,
  );
  assert.match(
    compose,
    /NORVA_PARTNERS_REVOLUT_API_LEASE_SECONDS: \$\{NORVA_PARTNERS_REVOLUT_API_LEASE_SECONDS:-240\}/,
  );
  assert.match(
    compose,
    /NORVA_PARTNERS_REVOLUT_BENEFICIARY_HMAC_KEYS_JSON: \$\{NORVA_PARTNERS_REVOLUT_BENEFICIARY_HMAC_KEYS_JSON:-\}/,
  );
  assert.match(
    compose,
    /NORVA_PARTNERS_REVOLUT_BENEFICIARY_HMAC_ACTIVE_VERSION: \$\{NORVA_PARTNERS_REVOLUT_BENEFICIARY_HMAC_ACTIVE_VERSION:-\}/,
  );
  assert.match(edge, /const BATCH_SIZE = 1;/);
  assert.match(edge, /const GLOBAL_LEASE_SECONDS = 300;/);
  assert.match(
    edge,
    /const transaction = await REVOLUT_CLIENT\.createOrGetTransfer\(job\);\s+await renewGlobalLease/,
  );
  assert.match(
    edge,
    /catch \(error\) \{\s+await renewGlobalLease[\s\S]*partners_worker_revolut_payout_retry/,
  );
  assert.doesNotMatch(compose, /REVOLUT_BUSINESS_ACCESS_TOKEN/);
  assert.doesNotMatch(envExample, /REVOLUT_BUSINESS_ACCESS_TOKEN/);
  assert.doesNotMatch(businessClient, /REVOLUT_BUSINESS_ACCESS_TOKEN/);
  for (const secret of [
    'REVOLUT_BUSINESS_CLIENT_ID',
    'REVOLUT_BUSINESS_ISSUER',
    'REVOLUT_BUSINESS_PRIVATE_KEY_PEM',
    'REVOLUT_BUSINESS_REFRESH_TOKEN',
    'REVOLUT_BUSINESS_SOURCE_ACCOUNTS_JSON',
    'REVOLUT_BUSINESS_MAX_FEE_MINOR_JSON',
  ]) {
    assert.match(compose, new RegExp(`${secret}: \\\${${secret}:-}`));
    assert.match(envExample, new RegExp(`^${secret}=$`, 'm'));
  }
  assert.match(envExample, /^NORVA_PARTNERS_REVOLUT_API_ENABLED=false$/m);
  assert.match(
    envExample,
    /^NORVA_PARTNERS_REVOLUT_BENEFICIARY_HMAC_KEYS_JSON=$/m,
  );
  assert.match(
    envExample,
    /^NORVA_PARTNERS_REVOLUT_BENEFICIARY_HMAC_ACTIVE_VERSION=$/m,
  );
  assert.match(envExample, /^REVOLUT_BUSINESS_ENVIRONMENT=$/m);
  assert.match(
    compose,
    /REVOLUT_BUSINESS_ENVIRONMENT: \$\{REVOLUT_BUSINESS_ENVIRONMENT:-\}/,
  );
  assert.match(envExample, /^NORVA_PARTNERS_REVOLUT_API_BATCH=1$/m);
  assert.match(envExample, /^NORVA_PARTNERS_REVOLUT_API_LEASE_SECONDS=240$/m);
  assert.match(
    parity,
    /Revolut API cron scheduled[\s\S]*jobname='norva-partners-revolut-api'/,
  );
  assert.match(
    config,
    /\[functions\.norva-partners-revolut-payout\]\nverify_jwt = false/,
  );
});

test('cron backups preserve active state and restore Revolut API fail-closed', () => {
  for (const file of [
    'ops/hetzner/scripts/01-dump-prod.sh',
    'ops/hetzner/backup/backup-nightly.sh',
  ]) {
    const script = read(file);
    assert.match(
      script,
      /cron\.schedule\(%L,%L,%L\); update cron\.job set active=%s where jobname=%L;/,
    );
    assert.match(script, /active::text/);
    assert.match(script, /norva-partners-revolut-api/);
  }

  const restore = read('ops/hetzner/backup/RESTORE.md');
  assert.match(restore, /ref-cron-jobs\.sql/);
  assert.match(
    restore,
    /where active and jobname='norva-partners-revolut-api'/,
  );
});

test('release docs do not claim an impossible Revolut sandbox payout E2E', () => {
  const runbook = read('docs/NORVA-PARTNERS-RUNBOOK.md');
  const evidence = read('docs/NORVA-PARTNERS-RELEASE-EVIDENCE.md');
  for (const document of [runbook, evidence]) {
    assert.match(document, /\/pay\/fields/);
    assert.match(document, /micro-virement[\s\S]{0,80}production/i);
    assert.match(document, /supervisé/i);
  }
  assert.doesNotMatch(runbook, /test sandbox de\s+bout en bout/i);
});
