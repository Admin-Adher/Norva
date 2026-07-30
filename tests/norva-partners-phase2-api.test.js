const test = require('node:test');
const assert = require('node:assert/strict');
const cryptoNode = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const workflowId = '11111111-2222-4333-8444-555555555555';
const applicationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const sessionId = '99999999-8888-4777-8666-555555555555';
const eventId = '12345678-1234-4234-8234-123456789abc';
const webhookSecret = 'didit-webhook-secret-at-least-thirty-two-characters';
const edgeSecret = 'referral-edge-secret-at-least-thirty-two-characters';
const cookieSecret = 'referral-cookie-secret-at-least-thirty-two-characters';
const code32 = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';

function bundled(entry, overrides = {}) {
  const output = esbuild.buildSync({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    platform: 'browser',
    format: 'cjs',
    target: 'es2022',
    write: false,
  }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    crypto: cryptoNode.webcrypto,
    TextEncoder,
    TextDecoder,
    URL,
    Headers,
    Request,
    Response,
    AbortSignal,
    Date,
    console,
    fetch,
    setTimeout,
    clearTimeout,
    ...overrides,
  });
  return module.exports;
}

function diditConfig(overrides = {}) {
  const values = {
    DIDIT_API_KEY: 'didit-api-key-at-least-sixteen',
    DIDIT_WORKFLOW_ID: workflowId,
    DIDIT_APPLICATION_ID: applicationId,
    DIDIT_ENVIRONMENT: 'sandbox',
    DIDIT_WEBHOOK_SECRET: webhookSecret,
    DIDIT_CALLBACK_URL: 'https://norva.tv/app#partners',
    DIDIT_ID_VERIFICATION_NODE_ID: 'id-primary',
    DIDIT_LIVENESS_NODE_ID: 'liveness-primary',
    DIDIT_FACE_MATCH_NODE_ID: 'face-primary',
    ...overrides,
  };
  return values;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('Didit configuration is complete, KYC-only and fail-closed', () => {
  const { loadDiditConfig } = bundled('supabase/functions/_shared/didit-partners.ts');
  const values = diditConfig();
  const config = plain(loadDiditConfig((name) => values[name]));
  assert.equal(config.workflowId, workflowId);
  assert.equal(config.applicationId, applicationId);
  assert.equal(config.callbackUrl, 'https://norva.tv/app#partners');
  assert.equal(Object.hasOwn(config, 'consentVersion'), false, 'consent comes from jurisdiction policy, not a global provider env');
  for (const overrides of [
    { DIDIT_API_KEY: '' },
    { DIDIT_CALLBACK_URL: 'https://evil.example/steal' },
    { DIDIT_WORKFLOW_ID: 'workflow-name' },
    { DIDIT_ENVIRONMENT: 'production' },
    { DIDIT_LIVENESS_NODE_ID: 'id-primary' },
    { DIDIT_WEBHOOK_SECRET: 'short' },
  ]) {
    const invalid = diditConfig(overrides);
    assert.equal(loadDiditConfig((name) => invalid[name]), null);
  }
});

test('KYC session input is exact and consent version is supplied by the sanitized policy', () => {
  const { parseKycSessionInput } = bundled('supabase/functions/_shared/didit-partners.ts');
  const expected = {
    language: 'fr',
    consentVersion: 'partners-fr-v1',
    consentGranted: true,
    capacityConfirmed: true,
  };
  assert.deepEqual(plain(parseKycSessionInput(expected)), expected);
  for (const invalid of [
    { ...expected, consentGranted: false },
    { ...expected, capacityConfirmed: false },
    { ...expected, language: 'fr-FR' },
    { ...expected, consentVersion: 'x' },
    { ...expected, businessName: 'Forbidden KYB' },
  ]) {
    assert.throws(() => parseKycSessionInput(invalid));
  }
});

test('Didit session creation sends no identity, contact, document or biometric data', async () => {
  const {
    diditCreateBody,
    loadDiditConfig,
    sanitizeDiditCreatedSession,
  } = bundled('supabase/functions/_shared/didit-partners.ts');
  const values = diditConfig();
  const config = loadDiditConfig((name) => values[name]);
  const vendorData = `kyr_${'a'.repeat(24)}`;
  assert.match(vendorData, /^kyr_[0-9a-f]{24}$/);
  assert.doesNotMatch(vendorData, /385d8450|11111111/);
  const body = plain(diditCreateBody(config, vendorData, 'fr'));
  assert.deepEqual(Object.keys(body).sort(), [
    'callback',
    'callback_method',
    'language',
    'vendor_data',
    'workflow_id',
  ]);
  assert.doesNotMatch(
    JSON.stringify(body),
    /email|phone|name|birth|document|selfie|portrait|metadata|expected_details|contact_details/i,
  );
  const created = plain(sanitizeDiditCreatedSession({
    session_id: sessionId,
    session_kind: 'user',
    session_token: 'must-never-be-copied',
    url: 'https://verify.didit.me/fr/session/opaque-token',
    vendor_data: vendorData,
    status: 'Not Started',
    workflow_id: workflowId,
    workflow_version: 4,
  }, config, vendorData));
  assert.deepEqual(created, {
    sessionId,
    workflowId,
    workflowVersion: 4,
    providerStatus: 'not_started',
    hostedUrl: 'https://verify.didit.me/fr/session/opaque-token',
  });
  for (const mutation of [
    { session_kind: 'business' },
    { workflow_id: applicationId },
    { status: 'Approved' },
    { url: 'https://evil.example/session/token' },
  ]) {
    assert.throws(() => sanitizeDiditCreatedSession({
      session_id: sessionId,
      session_kind: 'user',
      url: 'https://verify.didit.me/session/token',
      vendor_data: vendorData,
      status: 'Not Started',
      workflow_id: workflowId,
      workflow_version: 4,
      ...mutation,
    }, config, vendorData));
  }
});

test('Didit raw-body HMAC authenticates the full decision and stores only normalized minimum', async () => {
  const {
    loadDiditConfig,
    verifyAndNormalizeDiditWebhook,
  } = bundled('supabase/functions/_shared/didit-partners.ts');
  const values = diditConfig();
  const config = loadDiditConfig((name) => values[name]);
  const timestamp = 1774970000;
  const payload = {
    event_id: eventId,
    webhook_type: 'status.updated',
    timestamp,
    created_at: timestamp - 6,
    application_id: applicationId,
    environment: 'sandbox',
    session_id: sessionId,
    status: 'Approved',
    workflow_id: workflowId,
    workflow_version: 4,
    vendor_data: 'nvp_private',
    decision: {
      id_verifications: [{
        node_id: 'id-primary',
        status: 'Approved',
        age: 28,
        issuing_state: 'ESP',
        full_name: 'Must Be Discarded',
        front_image: 'https://private.example/document.jpg',
      }],
      liveness_checks: [{
        node_id: 'liveness-primary',
        status: 'Approved',
        video_url: 'https://private.example/liveness.mp4',
      }],
      face_matches: [{
        node_id: 'face-primary',
        status: 'Approved',
        source_image: 'https://private.example/face.jpg',
      }],
    },
  };
  const raw = Buffer.from(JSON.stringify(payload));
  const signature = cryptoNode.createHmac('sha256', webhookSecret).update(raw).digest('hex');
  const headers = new Headers({
    'X-Timestamp': String(timestamp),
    'X-Signature': signature,
    'X-Signature-Simple': 'must-not-be-trusted',
  });
  const result = plain(await verifyAndNormalizeDiditWebhook(
    new Uint8Array(raw),
    headers,
    config,
    timestamp,
  ));
  assert.deepEqual(result, {
    providerEventId: eventId,
    providerSessionId: sessionId,
    providerWorkflowId: workflowId,
    providerWorkflowVersion: 4,
    providerStatus: 'approved',
    eventCreatedAt: new Date((timestamp - 6) * 1000).toISOString(),
    documentAge: 28,
    documentCountryIso3: 'ESP',
    idCheckApproved: true,
    livenessApproved: true,
    faceMatchApproved: true,
    payloadHash: cryptoNode.createHash('sha256').update(raw).digest('hex'),
  });
  assert.doesNotMatch(
    JSON.stringify(result),
    /full_name|document\.jpg|liveness\.mp4|face\.jpg|vendor_data|decision/i,
  );

  const tampered = new Headers(headers);
  tampered.set('X-Signature', `${signature.slice(0, 63)}0`);
  await assert.rejects(() => verifyAndNormalizeDiditWebhook(
    new Uint8Array(raw),
    tampered,
    config,
    timestamp,
  ));
  await assert.rejects(() => verifyAndNormalizeDiditWebhook(
    new Uint8Array(raw),
    headers,
    config,
    timestamp + 301,
  ));
});

test('Didit webhook rejects KYB, non-status events and missing configured workflow nodes', async () => {
  const {
    loadDiditConfig,
    verifyAndNormalizeDiditWebhook,
  } = bundled('supabase/functions/_shared/didit-partners.ts');
  const values = diditConfig();
  const config = loadDiditConfig((name) => values[name]);
  const now = 1774970000;
  async function signed(payload) {
    const raw = Buffer.from(JSON.stringify(payload));
    return verifyAndNormalizeDiditWebhook(
      new Uint8Array(raw),
      new Headers({
        'X-Timestamp': String(now),
        'X-Signature': cryptoNode.createHmac('sha256', webhookSecret).update(raw).digest('hex'),
      }),
      config,
      now,
    );
  }
  const base = {
    event_id: eventId,
    webhook_type: 'status.updated',
    timestamp: now,
    created_at: now,
    application_id: applicationId,
    environment: 'sandbox',
    session_id: sessionId,
    status: 'Approved',
    workflow_id: workflowId,
    workflow_version: 1,
    decision: {
      id_verifications: [{
        node_id: 'id-primary', status: 'Approved', age: 25, issuing_state: 'FRA',
      }],
      liveness_checks: [{ node_id: 'liveness-primary', status: 'Approved' }],
      face_matches: [{ node_id: 'face-primary', status: 'Approved' }],
    },
  };
  await assert.rejects(() => signed({
    ...base,
    session_kind: 'business',
    business_session_id: sessionId,
  }));
  await assert.rejects(() => signed({ ...base, webhook_type: 'data.updated' }));
  await assert.rejects(() => signed({
    ...base,
    decision: { ...base.decision, face_matches: [] },
  }));
});

test('signed referral cookie is opaque, tamper-evident and hash-only at the DB boundary', async () => {
  const {
    claimHashFromSignedToken,
    loadReferralSecrets,
    newReferralClaim,
  } = bundled('supabase/functions/_shared/partners-referral.ts');
  const secrets = loadReferralSecrets((name) => ({
    NORVA_REFERRAL_EDGE_HMAC_SECRET: edgeSecret,
    NORVA_REFERRAL_COOKIE_SECRET: cookieSecret,
  })[name]);
  assert.ok(secrets);
  const claim = plain(await newReferralClaim(cookieSecret));
  assert.match(claim.cookieToken, /^v1\.[0-9a-f]{64}\.[0-9a-f]{64}$/);
  assert.match(claim.claimHash, /^[0-9a-f]{64}$/);
  assert.equal(
    await claimHashFromSignedToken(claim.cookieToken, cookieSecret),
    claim.claimHash,
  );
  const tampered = `${claim.cookieToken.slice(0, -1)}${claim.cookieToken.endsWith('0') ? '1' : '0'}`;
  await assert.rejects(() => claimHashFromSignedToken(tampered, cookieSecret));
  assert.equal(loadReferralSecrets((name) => ({
    NORVA_REFERRAL_EDGE_HMAC_SECRET: edgeSecret,
    NORVA_REFERRAL_COOKIE_SECRET: edgeSecret,
  })[name]), null, 'transport and cookie keys must be distinct');
});

test('Cloudflare and Edge share the exact short-lived internal HMAC contract', async () => {
  const cloudflare = bundled('functions/_shared/partners-referral.js');
  const edge = bundled('supabase/functions/_shared/partners-referral.ts');
  const internal = await cloudflare.buildInternalResolveRequest({
    code: code32,
    networkValue: '203.0.113.5',
    userAgentValue: 'Norva Test',
    secret: edgeSecret,
    nowEpochSeconds: 1774970000,
    nonce: '0123456789abcdef0123456789abcdef0123456789abcdef',
  });
  const request = new Request('https://edge.example/resolve', {
    method: 'POST',
    headers: internal.headers,
    body: internal.body,
  });
  const verified = plain(await edge.assertValidInternalSignature(
    request,
    new TextEncoder().encode(internal.body),
    edgeSecret,
    '/resolve',
    1774970000,
  ));
  assert.match(verified.nonceHash, /^[0-9a-f]{64}$/);
  const body = JSON.parse(internal.body);
  assert.equal(body.code, code32);
  assert.match(body.networkHash, /^[0-9a-f]{64}$/);
  assert.match(body.userAgentHash, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(internal.body, /203\.0\.113\.5|Norva Test/);
  assert.deepEqual(plain(edge.parseReferralResolveInput(body)), body);
  await assert.rejects(() => edge.assertValidInternalSignature(
    request,
    new TextEncoder().encode(`${internal.body} `),
    edgeSecret,
    '/resolve',
    1774970000,
  ));
});

test('Cloudflare cookie contract is __Host, HttpOnly, secure and invisible to app JS', () => {
  const cloudflare = bundled('functions/_shared/partners-referral.js');
  const token = `v1.${'a'.repeat(64)}.${'b'.repeat(64)}`;
  const cookie = cloudflare.referralCookie(token);
  assert.equal(
    cookie,
    `__Host-norva_referral=${token}; Max-Age=2592000; Path=/; Secure; HttpOnly; SameSite=Lax`,
  );
  assert.equal(
    cloudflare.readReferralCookie(`other=1; __Host-norva_referral=${token}`),
    token,
  );
  assert.match(cloudflare.clearReferralCookie(), /Max-Age=0/);
  const appSources = [
    read('public/js/authApi.js'),
    read('public/js/cloudApi.js'),
    read('public/js/app.js'),
  ].join('\n');
  assert.doesNotMatch(appSources, /__Host-norva_referral|claimToken/);
  assert.match(read('functions/api/partners/claim.js'), /readReferralCookie/);
});

test('public /r resolver sets the signed cookie server-side and redirects without the code', async () => {
  const token = `v1.${'a'.repeat(64)}.${'b'.repeat(64)}`;
  let captured;
  const mockFetch = async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({
      version: '2026-07-29',
      correlationId: 'prf_0123456789abcdef01234567',
      data: {
        accepted: true,
        cookieToken: token,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const resolver = bundled('functions/r/[[path]].js', { fetch: mockFetch });
  const response = await resolver.onRequest({
    request: new Request(`https://norva.tv/r/${code32}`, {
      headers: {
        'CF-Connecting-IP': '203.0.113.5',
        'User-Agent': 'Norva Test',
      },
    }),
    env: {
      NORVA_PARTNERS_REFERRAL_EDGE_URL:
        'https://project.supabase.co/functions/v1/norva-partners-referral/resolve',
      NORVA_REFERRAL_REDIRECT_URL: 'https://norva.tv/',
      NORVA_REFERRAL_EDGE_HMAC_SECRET: edgeSecret,
    },
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('Location'), 'https://norva.tv/?referral=ready');
  assert.equal(
    response.headers.get('Set-Cookie'),
    `__Host-norva_referral=${token}; Max-Age=2592000; Path=/; Secure; HttpOnly; SameSite=Lax`,
  );
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store, max-age=0');
  assert.doesNotMatch(response.headers.get('Location'), new RegExp(code32));
  assert.equal(
    captured.url,
    'https://project.supabase.co/functions/v1/norva-partners-referral/resolve',
  );
  assert.match(captured.options.headers['X-Norva-Signature'], /^[0-9a-f]{64}$/);
  assert.doesNotMatch(captured.options.body, /203\.0\.113\.5|Norva Test/);
});

test('same-origin post-auth claim reads HttpOnly cookie in Pages and clears only terminal outcomes', async () => {
  const token = `v1.${'c'.repeat(64)}.${'d'.repeat(64)}`;
  let captured;
  const mockFetch = async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({
      version: '2026-07-29',
      correlationId: 'prt_0123456789abcdef01234567',
      data: {
        schema_version: 1,
        action: 'referral_claimed',
        replayed: false,
        outcome: 'attributed',
        terminal: true,
        attribution: {
          status: 'attributed',
          attributed_at: '2026-07-29T22:30:00.000Z',
        },
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const claim = bundled('functions/api/partners/claim.js', { fetch: mockFetch });
  const response = await claim.onRequest({
    request: new Request('https://norva.tv/api/partners/claim', {
      method: 'POST',
      headers: {
        Origin: 'https://norva.tv',
        Authorization: `Bearer ${'x'.repeat(32)}`,
        'Content-Type': 'application/json',
        Cookie: `__Host-norva_referral=${token}`,
      },
      body: '{}',
    }),
    env: {
      NORVA_PARTNERS_API_URL:
        'https://project.supabase.co/functions/v1/norva-partners',
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(plain(await response.json()), {
    version: 1,
    claimed: true,
    state: 'attributed',
  });
  assert.match(response.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.equal(
    captured.url,
    'https://project.supabase.co/functions/v1/norva-partners/referral/claim',
  );
  assert.equal(JSON.parse(captured.options.body).claimToken, token);
  assert.match(
    captured.options.headers['Idempotency-Key'],
    /^refclaim:[0-9a-f]{48}$/,
  );

  const transient = bundled('functions/api/partners/claim.js', {
    fetch: async () => new Response(JSON.stringify({
      error: { code: 'partners_temporarily_unavailable' },
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    }),
  });
  const retry = await transient.onRequest({
    request: new Request('https://norva.tv/api/partners/claim', {
      method: 'POST',
      headers: {
        Origin: 'https://norva.tv',
        Authorization: `Bearer ${'x'.repeat(32)}`,
        'Content-Type': 'application/json',
        Cookie: `__Host-norva_referral=${token}`,
      },
      body: '{}',
    }),
    env: {
      NORVA_PARTNERS_API_URL:
        'https://project.supabase.co/functions/v1/norva-partners',
    },
  });
  assert.equal(retry.status, 503);
  assert.equal(retry.headers.get('Set-Cookie'), null, 'retryable failures keep the claim cookie');
});

test('payout profile accepts only opaque provider tokens and never returns them', () => {
  const payout = bundled('supabase/functions/_shared/partners-payout.ts');
  const input = {
    provider: 'wise',
    beneficiaryTokenRef: 'recipient_tok_abC123-opaque',
    displayMasked: '•••• 1234',
    currency: 'EUR',
  };
  assert.deepEqual(plain(payout.parsePayoutProfileInput(input)), input);
  for (const invalid of [
    { ...input, provider: 'crypto' },
    { ...input, currency: 'eur' },
    { ...input, beneficiaryTokenRef: 'FR7630006000011234567890189' },
    { ...input, beneficiaryTokenRef: '4111111111111111' },
    { ...input, beneficiaryTokenRef: '123456789:1234567890' },
    { ...input, beneficiaryTokenRef: 'person@example.test' },
    { ...input, iban: 'FR7630006000011234567890189' },
  ]) {
    assert.throws(() => payout.parsePayoutProfileInput(invalid));
  }

  const readResult = plain(payout.sanitizePayoutProfileGet({
    schema_version: 1,
    account: { id: 'prt_0123456789abcdef01234567', status: 'active' },
    fiscal: { status: 'verified', country_code: 'FR' },
    profile: {
      provider: 'wise',
      display_masked: '•••• 1234',
      currency: 'EUR',
      status: 'active',
    },
    profiles: [{
      provider: 'wise',
      display_masked: '•••• 1234',
      currency: 'EUR',
      status: 'active',
    }],
    readiness: { ready: false, payouts_live: false, reason: 'payouts_not_live' },
  }));
  assert.doesNotMatch(
    JSON.stringify(readResult),
    /beneficiary|token_ref|iban|account_number|routing/i,
  );
  const saved = plain(payout.sanitizePayoutProfileSet({
    schema_version: 1,
    action: 'payout_profile_saved',
    replayed: false,
    profile: {
      provider: 'wise',
      display_masked: '•••• 1234',
      currency: 'EUR',
      status: 'active',
    },
  }));
  assert.equal(saved.profile.display_masked, '•••• 1234');
});

test('phase 2 security boundaries are separately configured and never trust simple webhook signatures', () => {
  const config = read('supabase/config.toml');
  const didit = read('supabase/functions/_shared/didit-partners.ts');
  const webhook = read('supabase/functions/norva-partners-kyc-webhook/index.ts');
  const referral = read('supabase/functions/norva-partners-referral/index.ts');
  const member = read('supabase/functions/norva-partners/index.ts');
  assert.match(config, /\[functions\.norva-partners-kyc-webhook\]\nverify_jwt = false/);
  assert.match(config, /\[functions\.norva-partners-referral\]\nverify_jwt = false/);
  assert.match(didit, /headers\.get\("X-Signature"\)/);
  assert.doesNotMatch(didit, /X-Signature-Simple/);
  assert.match(
    webhook,
    /error\.code === "P0006"[\s\S]*problem\(404, "webhook_resource_unknown"/,
    'a signed event racing session persistence must receive a retryable not-found response',
  );
  assert.doesNotMatch(webhook, /console\[[^\]]+\]\([^)]*(?:rawBody|event|session|decision|document|payload)/s);
  assert.doesNotMatch(referral, /console\[[^\]]+\]\([^)]*(?:code|claim|network|userAgent|nonce)/s);
  assert.match(member, /p_beneficiary_token_ref: input\.beneficiaryTokenRef/);
  assert.doesNotMatch(member, /beneficiaryTokenRef[\s\S]*cleanData\s*=\s*\{/, 'token refs are never constructed into public responses');
});
