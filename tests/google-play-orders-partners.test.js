const test = require('node:test');
const assert = require('node:assert/strict');
const cryptoNode = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const modulePath = path.join(
  root,
  'supabase/functions/_shared/google-play-orders.mjs',
);
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
  .replace(/\r\n/g, '\n');

if (!globalThis.crypto) globalThis.crypto = cryptoNode.webcrypto;

let ordersModule;
async function orders() {
  if (!ordersModule) {
    ordersModule = await import(pathToFileURL(modulePath).href);
  }
  return ordersModule;
}

const orderId = 'GPA.1234-5678-9012-34567..0';
const productId = 'norva_plus_monthly';
const processedAt = '2026-07-29T14:32:00.000Z';

function money(currencyCode, units, nanos = 0) {
  return { currencyCode, units: String(units), nanos };
}

function processedOrder(overrides = {}) {
  return {
    orderId,
    purchaseToken: 'must-never-leave-the-adapter',
    buyerAddress: {
      buyerCountry: 'FR',
      buyerPostcode: '75001',
    },
    state: 'PROCESSED',
    total: money('USD', 4, 990_000_000),
    tax: money('USD', 0, 830_000_000),
    lineItems: [{
      productId,
      productTitle: 'localized customer-facing title',
      subscriptionDetails: { basePlanId: 'monthly' },
    }],
    orderHistory: {
      processedEvent: { eventTime: processedAt },
    },
    ...overrides,
  };
}

test('Google Money conversion is exact for ISO exponents and rejects rounding', async () => {
  const { googlePlayMoneyToMinor } = await orders();
  assert.deepEqual(
    googlePlayMoneyToMinor(money('USD', 4, 990_000_000), 2),
    { currency: 'USD', minor: 499 },
  );
  assert.deepEqual(
    googlePlayMoneyToMinor(money('JPY', 499), 0),
    { currency: 'JPY', minor: 499 },
  );
  assert.deepEqual(
    googlePlayMoneyToMinor(money('KWD', 4, 999_000_000), 3),
    { currency: 'KWD', minor: 4999 },
  );
  assert.throws(
    () => googlePlayMoneyToMinor(money('USD', 1, 1), 2),
    /google_play_money_not_minor_exact/,
  );
  assert.throws(
    () => googlePlayMoneyToMinor(money('USD', 1, -1), 2),
    /google_play_money_sign_invalid/,
  );
  assert.throws(
    () => googlePlayMoneyToMinor(money('USD', '-1', 0), 2),
    /google_play_money_out_of_range/,
  );
  assert.throws(
    () => googlePlayMoneyToMinor(money('US', 1), 2),
    /google_play_money_invalid/,
  );
  assert.throws(
    () => googlePlayMoneyToMinor(
      money('USD', String(Number.MAX_SAFE_INTEGER)),
      2,
    ),
    /google_play_money_out_of_range/,
  );
});

test('processed Google order yields exact paid-after-discount base excluding tax', async () => {
  const {
    googlePlayOrderFinancialCurrency,
    normalizeGooglePlayOrderFinancials,
  } = await orders();
  const raw = processedOrder();
  const options = {
    orderId,
    eventType: 'capture',
    expectedProductId: productId,
    currencyExponent: 2,
  };
  assert.equal(googlePlayOrderFinancialCurrency(raw, options), 'USD');
  const normalized = normalizeGooglePlayOrderFinancials(raw, options);
  assert.deepEqual(normalized, {
    eventType: 'capture',
    currency: 'USD',
    currencyExponent: 2,
    grossMinor: 499,
    discountMinor: null,
    taxMinor: 83,
    eligibleMinor: 416,
    observedAt: processedAt,
  });
  const serialized = JSON.stringify(normalized);
  assert.doesNotMatch(
    serialized,
    /purchaseToken|buyerAddress|buyerPostcode|localized customer-facing title/,
  );

  const renewal = normalizeGooglePlayOrderFinancials(raw, {
    ...options,
    eventType: 'renewal',
  });
  assert.equal(renewal.eventType, 'renewal');
  assert.equal(renewal.eligibleMinor, 416);
});

test('full and uniquely matchable partial refunds are deterministic', async () => {
  const { normalizeGooglePlayOrderFinancials } = await orders();
  const full = processedOrder({
    state: 'REFUNDED',
    orderHistory: {
      processedEvent: { eventTime: processedAt },
      refundEvent: {
        eventTime: '2026-07-30T08:00:00Z',
        refundReason: 'CHARGEBACK',
        refundDetails: {
          total: money('USD', 4, 990_000_000),
          tax: money('USD', 0, 830_000_000),
        },
      },
    },
  });
  const fullResult = normalizeGooglePlayOrderFinancials(full, {
    orderId,
    eventType: 'refund',
    expectedProductId: productId,
    currencyExponent: 2,
  });
  assert.equal(fullResult.eventType, 'chargeback');
  assert.equal(fullResult.grossMinor, 499);
  assert.equal(fullResult.taxMinor, 83);
  assert.equal(fullResult.eligibleMinor, 416);
  assert.equal(fullResult.observedAt, '2026-07-30T08:00:00.000Z');

  const partialEvent = {
    createTime: '2026-07-30T08:00:00Z',
    processTime: '2026-07-30T08:02:00Z',
    state: 'PROCESSED_SUCCESSFULLY',
    refundDetails: {
      total: money('USD', 2),
      tax: money('USD', 0, 330_000_000),
    },
  };
  const partial = processedOrder({
    state: 'PARTIALLY_REFUNDED',
    orderHistory: {
      processedEvent: { eventTime: processedAt },
      partialRefundEvents: [partialEvent],
    },
  });
  const partialResult = normalizeGooglePlayOrderFinancials(partial, {
    orderId,
    eventType: 'refund',
    expectedProductId: productId,
    currencyExponent: 2,
  });
  assert.equal(partialResult.eventType, 'refund');
  assert.equal(partialResult.grossMinor, 200);
  assert.equal(partialResult.taxMinor, 33);
  assert.equal(partialResult.eligibleMinor, 167);

  assert.throws(
    () => normalizeGooglePlayOrderFinancials(processedOrder({
      state: 'PARTIALLY_REFUNDED',
      orderHistory: {
        partialRefundEvents: [
          partialEvent,
          { ...partialEvent, processTime: '2026-07-30T09:02:00Z' },
        ],
      },
    }), {
      orderId,
      eventType: 'refund',
      expectedProductId: productId,
      currencyExponent: 2,
    }),
    /google_play_partial_refund_ambiguous/,
  );
});

test('normalization rejects product, order, state, currency and tax ambiguity', async () => {
  const { normalizeGooglePlayOrderFinancials } = await orders();
  const options = {
    orderId,
    eventType: 'capture',
    expectedProductId: productId,
    currencyExponent: 2,
  };
  assert.throws(
    () => normalizeGooglePlayOrderFinancials(
      processedOrder({ orderId: 'GPA.other' }),
      options,
    ),
    /google_play_order_response_invalid/,
  );
  assert.throws(
    () => normalizeGooglePlayOrderFinancials(processedOrder(), {
      ...options,
      expectedProductId: 'another_product',
    }),
    /google_play_order_product_mismatch/,
  );
  assert.throws(
    () => normalizeGooglePlayOrderFinancials(
      processedOrder({
        state: 'PENDING',
        orderHistory: {},
      }),
      options,
    ),
    /google_play_order_not_processed/,
  );
  assert.throws(
    () => normalizeGooglePlayOrderFinancials(
      processedOrder({ tax: money('EUR', 0, 830_000_000) }),
      options,
    ),
    /google_play_money_currency_mismatch/,
  );
  assert.throws(
    () => normalizeGooglePlayOrderFinancials(
      processedOrder({ tax: money('USD', 5) }),
      options,
    ),
    /google_play_money_currency_mismatch/,
  );
});

test('service-account JWT has the fixed Android Publisher audience and valid signature', async () => {
  const {
    createGooglePlayServiceAccountJwt,
    googlePlayOrdersConfiguration,
  } = await orders();
  const { privateKey, publicKey } = cryptoNode.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const privatePem = privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }).toString();
  const configuration = googlePlayOrdersConfiguration({
    packageName: 'tv.norva.phone',
    serviceAccountJson: JSON.stringify({
      type: 'service_account',
      client_email: 'play-orders@norva.example',
      private_key_id: 'rotation-1',
      private_key: privatePem,
      token_uri: 'https://oauth2.googleapis.com/token',
    }),
  });
  const nowMs = Date.parse('2026-07-30T10:00:00Z');
  const jwt = await createGooglePlayServiceAccountJwt(
    configuration.serviceAccount,
    { nowMs },
  );
  const [encodedHeader, encodedClaims, encodedSignature] = jwt.split('.');
  const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString());
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT', kid: 'rotation-1' });
  assert.equal(claims.iss, 'play-orders@norva.example');
  assert.equal(
    claims.scope,
    'https://www.googleapis.com/auth/androidpublisher',
  );
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(claims.exp - claims.iat, 3600);
  assert.equal(
    cryptoNode.verify(
      'RSA-SHA256',
      Buffer.from(`${encodedHeader}.${encodedClaims}`),
      publicKey,
      Buffer.from(encodedSignature, 'base64url'),
    ),
    true,
  );
});

test('OAuth exchange and Orders GET are bounded and never expose provider bodies', async () => {
  const {
    fetchGooglePlayOrder,
    googlePlayAccessToken,
    googlePlayOrdersConfiguration,
  } = await orders();
  const { privateKey } = cryptoNode.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const configuration = googlePlayOrdersConfiguration({
    packageName: 'tv.norva.phone',
    serviceAccountJson: JSON.stringify({
      type: 'service_account',
      client_email: 'play-orders@norva.example',
      private_key: privateKey.export({
        type: 'pkcs8',
        format: 'pem',
      }).toString(),
    }),
  });
  let oauthRequest;
  const token = await googlePlayAccessToken(configuration, {
    useCache: false,
    nowMs: Date.parse('2026-07-30T10:00:00Z'),
    fetchImpl: async (url, init) => {
      oauthRequest = { url, init };
      return new Response(JSON.stringify({
        access_token: 'opaque-access-token-value',
        expires_in: 3600,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(token, 'opaque-access-token-value');
  assert.equal(oauthRequest.url, 'https://oauth2.googleapis.com/token');
  assert.match(oauthRequest.init.body, /grant_type=/);
  assert.match(oauthRequest.init.body, /assertion=/);
  await assert.rejects(
    googlePlayAccessToken(configuration, {
      useCache: false,
      nowMs: Date.parse('2026-07-30T10:00:00Z'),
      fetchImpl: async () => new Response(
        'invalid response containing buyer@example.com',
        { status: 200 },
      ),
    }),
    (error) => {
      assert.equal(error.kind, 'auth');
      assert.equal(error.code, 'google_play_oauth_response_invalid');
      assert.doesNotMatch(error.message, /buyer@example\.com/);
      return true;
    },
  );

  let orderRequest;
  const expected = processedOrder();
  const fetched = await fetchGooglePlayOrder(configuration, orderId, {
    accessToken: token,
    fetchImpl: async (url, init) => {
      orderRequest = { url, init };
      return new Response(JSON.stringify(expected), { status: 200 });
    },
  });
  assert.equal(fetched.orderId, orderId);
  assert.equal(
    orderRequest.url,
    'https://androidpublisher.googleapis.com/androidpublisher/v3/' +
      'applications/tv.norva.phone/orders/' +
      'GPA.1234-5678-9012-34567..0',
  );
  assert.equal(
    orderRequest.init.headers.Authorization,
    'Bearer opaque-access-token-value',
  );

  const privateProviderBody = JSON.stringify({
    error: 'buyer buyer@example.com at 75001',
  });
  await assert.rejects(
    fetchGooglePlayOrder(configuration, orderId, {
      accessToken: token,
      fetchImpl: async () => new Response(privateProviderBody, { status: 404 }),
    }),
    (error) => {
      assert.equal(error.code, 'google_play_orders_http_404');
      assert.doesNotMatch(error.message, /buyer@example\.com|75001/);
      return true;
    },
  );
});

test('configuration is optional only when both values are absent', async () => {
  const { googlePlayOrdersConfiguration } = await orders();
  assert.equal(googlePlayOrdersConfiguration({}), null);
  assert.throws(
    () => googlePlayOrdersConfiguration({
      packageName: 'tv.norva.phone',
    }),
    /google_play_config_incomplete/,
  );
  assert.throws(
    () => googlePlayOrdersConfiguration({
      packageName: 'tv.norva.phone',
      serviceAccountJson: JSON.stringify({
        type: 'service_account',
        client_email: 'play@norva.example',
        private_key: 'not-a-key',
      }),
    }),
    /google_play_service_account_invalid/,
  );
});

test('billing webhook gates Orders calls on attribution and currency metadata', () => {
  const billing = read('supabase/functions/norva-billing-webhook/index.ts');
  const adapter = read(
    'supabase/functions/_shared/google-play-orders.mjs',
  );
  const compose = read('ops/hetzner/docker-compose.supabase.yml');
  const envExample = read('ops/hetzner/.env.hetzner.example');
  assert.match(billing, /partners_worker_financial_observation_required/);
  assert.match(billing, /partners_worker_currency_exponent_resolve/);
  assert.match(billing, /await fetchGooglePlayOrder/);
  assert.match(billing, /await enrichGooglePlayPartnersObservation/);
  assert.match(billing, /await ingestPartnerFinancialFact/);
  assert.ok(
    billing.indexOf('await enrichGooglePlayPartnersObservation') <
      billing.indexOf('await ingestPartnerFinancialFact'),
  );
  assert.doesNotMatch(adapter, /console\./);
  for (const contract of [compose, envExample]) {
    assert.match(contract, /GOOGLE_PLAY_SERVICE_ACCOUNT_JSON/);
    assert.match(contract, /GOOGLE_PLAY_PACKAGE_NAME/);
  }
});
