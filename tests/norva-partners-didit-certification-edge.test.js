const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cryptoNode = require('node:crypto');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
  .replace(/\r\n/g, '\n');

function bundled(entry) {
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
    Uint8Array,
    ArrayBuffer,
    DataView,
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
  });
  return module.exports;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('Didit certification input is exact, explicit and bounded', () => {
  const { parseKycCertificationInput } = bundled(
    'supabase/functions/_shared/didit-partners.ts',
  );
  const expected = {
    language: 'fr',
    consentVersion: 'partners-didit-certification-v1',
    consentGranted: true,
    capacityConfirmed: true,
    confirmation: 'CERTIFIER DIDIT',
    justification: 'Validation Didit supervisée.',
  };
  assert.deepEqual(plain(parseKycCertificationInput(expected)), expected);
  assert.equal(
    parseKycCertificationInput({
      ...expected,
      justification: '  Validation Didit supervisée.  ',
    }).justification,
    expected.justification,
  );
  assert.equal(
    parseKycCertificationInput({
      ...expected,
      justification: 'x'.repeat(1000),
    }).justification.length,
    1000,
  );
  for (const invalid of [
    { ...expected, consentVersion: 'partners-didit-certification-v2' },
    { ...expected, consentGranted: false },
    { ...expected, capacityConfirmed: false },
    { ...expected, confirmation: 'CERTIFIER' },
    { ...expected, language: 'fr-FR' },
    { ...expected, justification: 'trop court' },
    { ...expected, justification: 'x'.repeat(1001) },
    { ...expected, justification: 'Validation\nDidit supervisée.' },
    { ...expected, justification: `valide mais interdit\u0000${'x'.repeat(12)}` },
    { ...expected, extra: true },
  ]) {
    assert.throws(() => parseKycCertificationInput(invalid));
  }
});

test('Didit certification RPC sanitizers expose no provider identifiers', () => {
  const shared = bundled('supabase/functions/_shared/didit-partners.ts');
  const expiresAt = '2026-08-10T12:00:00.000Z';
  assert.deepEqual(plain(shared.sanitizeKycCertificationPrepareRpc({
    schema_version: 1,
    action: 'kyc_certification_reserved',
    replayed: false,
    certification: {
      key: `kcf_${'a'.repeat(24)}`,
      status: 'reserved',
      expires_at: expiresAt,
    },
  })), {
    schema_version: 1,
    action: 'kyc_certification_reserved',
    replayed: false,
    certification: {
      key: `kcf_${'a'.repeat(24)}`,
      status: 'reserved',
      expires_at: expiresAt,
    },
  });
  assert.deepEqual(plain(shared.sanitizeKycCertificationSessionRecordRpc({
    schema_version: 1,
    action: 'kyc_certification_session_recorded',
    replayed: true,
    certification: { status: 'pending', expires_at: expiresAt },
  })), {
    schema_version: 1,
    action: 'kyc_certification_session_recorded',
    replayed: true,
    certification: { status: 'pending', expires_at: expiresAt },
  });
  assert.deepEqual(plain(shared.sanitizeKycCertificationCreateClaimRpc({
    schema_version: 1,
    action: 'kyc_certification_create_claimed',
    claimed: true,
    certification: {
      status: 'reserved',
      expires_at: expiresAt,
      provider_create_dispatched_at: '2026-08-10T10:00:00.000Z',
    },
  })), {
    schema_version: 1,
    action: 'kyc_certification_create_claimed',
    claimed: true,
    certification: {
      status: 'reserved',
      expires_at: expiresAt,
      provider_create_dispatched_at: '2026-08-10T10:00:00.000Z',
    },
  });
  assert.deepEqual(plain(shared.sanitizeKycCertificationBindingMatchRpc({
    schema_version: 1,
    action: 'kyc_certification_binding_matched',
    matched: true,
    certification: { status: 'pending', expires_at: expiresAt },
  })), {
    schema_version: 1,
    action: 'kyc_certification_binding_matched',
    matched: true,
    certification: { status: 'pending', expires_at: expiresAt },
  });
  assert.deepEqual(plain(shared.sanitizeKycCertificationWebhookRpc({
    schema_version: 1,
    action: 'kyc_certification_result_applied',
    replayed: false,
    purge_status: 'purge_pending',
    certification: { status: 'approved', verified: true },
  })), {
    schema_version: 1,
    action: 'kyc_certification_result_applied',
    replayed: false,
    purge_status: 'purge_pending',
    certification: { status: 'approved', verified: true },
  });
  assert.deepEqual(plain(shared.sanitizeKycCertificationWebhookRpc({
    schema_version: 1,
    action: 'kyc_certification_result_applied',
    replayed: false,
    purge_status: 'purged',
    certification: { status: 'approved', verified: false },
  })), {
    schema_version: 1,
    action: 'kyc_certification_result_applied',
    replayed: false,
    purge_status: 'purged',
    certification: { status: 'approved', verified: false },
  });
  assert.deepEqual(plain(shared.sanitizeKycCertificationWebhookRpc({
    schema_version: 1,
    action: 'kyc_certification_result_quarantined',
    replayed: false,
    purge_status: 'purge_pending',
    certification: {
      status: 'quarantined',
      verified: false,
      reason: 'provider_config_mismatch',
    },
  })), {
    schema_version: 1,
    action: 'kyc_certification_result_quarantined',
    replayed: false,
    purge_status: 'purge_pending',
    certification: {
      status: 'quarantined',
      verified: false,
      reason: 'provider_config_mismatch',
    },
  });
  for (const invalid of [
    {
      schema_version: 1,
      action: 'kyc_certification_result_applied',
      replayed: false,
      certification: { status: 'declined', verified: true },
    },
    {
      schema_version: 1,
      action: 'kyc_certification_result_applied',
      replayed: false,
      certification: { status: 'quarantined', verified: false },
    },
    {
      schema_version: 1,
      action: 'kyc_certification_result_quarantined',
      replayed: false,
      certification: {
        status: 'quarantined',
        verified: false,
        reason: 'manual_override',
      },
    },
    {
      schema_version: 1,
      action: 'kyc_certification_result_applied',
      replayed: false,
      purge_status: 'purge_pending',
      certification: {
        status: 'approved',
        verified: true,
        provider_session_id: 'forbidden',
      },
    },
  ]) {
    assert.throws(() => shared.sanitizeKycCertificationWebhookRpc(invalid));
  }
});

test('Didit certification preflight exposes only exact booleans and consistent readiness', () => {
  const { sanitizeKycCertificationPreflightRpc } = bundled(
    'supabase/functions/_shared/didit-partners.ts',
  );
  const requirements = {
    privacy_approved: true,
    coverage_open: true,
    partners_membership_closed: true,
    cash_payouts_closed: true,
    tv_relay_closed: true,
    revolut_api_closed: true,
    aal2: true,
    fresh_aal2: true,
  };
  const expected = {
    schema_version: 1,
    action: 'kyc_certification_preflight',
    ready: true,
    requirements,
  };
  assert.deepEqual(
    plain(sanitizeKycCertificationPreflightRpc(expected)),
    expected,
  );
  for (const invalid of [
    { ...expected, ready: false },
    { ...expected, requirements: { ...requirements, fresh_aal2: false } },
    {
      ...expected,
      requirements: { ...requirements, aal2: false, fresh_aal2: true },
    },
    {
      ...expected,
      requirements: { ...requirements, privacy_approved: 'true' },
    },
    { ...expected, requirements: { ...requirements, operator_id: 'forbidden' } },
    { ...expected, provider_session_id: 'forbidden' },
  ]) {
    assert.throws(() => sanitizeKycCertificationPreflightRpc(invalid));
  }
});

test('certification vendor data is opaque and accepted by the hosted-session contract', () => {
  const shared = bundled('supabase/functions/_shared/didit-partners.ts');
  const values = {
    DIDIT_API_KEY: 'didit-api-key-at-least-sixteen',
    DIDIT_WORKFLOW_ID: '11111111-2222-4333-8444-555555555555',
    DIDIT_APPLICATION_ID: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    DIDIT_ENVIRONMENT: 'sandbox',
    DIDIT_SESSION_EXPIRATION_SECONDS: '604800',
    DIDIT_WEBHOOK_SECRET: 'didit-webhook-secret-at-least-thirty-two-characters',
    DIDIT_CALLBACK_URL: 'https://norva.tv/partners-kyc-return',
    DIDIT_ID_VERIFICATION_NODE_ID: 'id-primary',
    DIDIT_LIVENESS_NODE_ID: 'liveness-primary',
    DIDIT_FACE_MATCH_NODE_ID: 'face-primary',
  };
  const config = shared.loadDiditConfig((name) => values[name]);
  const body = plain(shared.diditCreateBody(
    config,
    `kcf_${'b'.repeat(24)}`,
    'fr',
  ));
  assert.equal(body.vendor_data, `kcf_${'b'.repeat(24)}`);
  assert.doesNotMatch(
    JSON.stringify(body),
    /email|name|user_id|account_id|justification|confirmation|session_token/i,
  );
});

test('Didit create failures classify bounded credits and rate limits without exposing bodies', () => {
  const shared = bundled('supabase/functions/_shared/didit-partners.ts');
  assert.equal(shared.classifyDiditCreateError(429, null), 'rate_limited');
  assert.equal(shared.classifyDiditCreateError(402, null), 'credits_unavailable');
  assert.equal(shared.classifyDiditCreateError(400, JSON.stringify({
    detail: "You don't have enough credits to perform this request. Please top up at https://business.didit.me",
  })), 'credits_unavailable');
  assert.equal(shared.classifyDiditCreateError(400, JSON.stringify({
    detail: 'Invalid workflow_id.',
  })), 'other');
  assert.equal(
    shared.classifyDiditCreateError(400, 'x'.repeat(4_097)),
    'other',
  );

  const edge = read('supabase/functions/norva-partners/index.ts');
  assert.match(edge, /readBoundedDiditResponseBody\(response, 4_096\)/);
  assert.match(edge, /providerError === "rate_limited"[\s\S]*429[\s\S]*"rate_limited"/);
  assert.match(edge, /providerError === "credits_unavailable"[\s\S]*"kyc_billing_unavailable"/);
  assert.doesNotMatch(
    edge,
    /console\[[^\]]+\]\([^)]*(?:boundedBody|providerError|response\.body)/s,
  );
});

test('Didit pending recovery sanitizes one exact active KYC session and rejects terminal or ambiguous rows', () => {
  const shared = bundled('supabase/functions/_shared/didit-partners.ts');
  const values = {
    DIDIT_API_KEY: 'didit-api-key-at-least-sixteen',
    DIDIT_WORKFLOW_ID: '11111111-2222-4333-8444-555555555555',
    DIDIT_APPLICATION_ID: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    DIDIT_ENVIRONMENT: 'sandbox',
    DIDIT_SESSION_EXPIRATION_SECONDS: '604800',
    DIDIT_WEBHOOK_SECRET: 'didit-webhook-secret-at-least-thirty-two-characters',
    DIDIT_CALLBACK_URL: 'https://norva.tv/partners-kyc-return',
    DIDIT_ID_VERIFICATION_NODE_ID: 'id-primary',
    DIDIT_LIVENESS_NODE_ID: 'liveness-primary',
    DIDIT_FACE_MATCH_NODE_ID: 'face-primary',
  };
  const config = shared.loadDiditConfig((name) => values[name]);
  const key = `kcf_${'d'.repeat(24)}`;
  const candidate = {
    session_id: '99999999-8888-4777-8666-555555555555',
    session_url: 'https://verify.didit.me/session/recovered-token',
    status: 'Awaiting User',
    vendor_data: key,
    workflow_id: config.workflowId,
    session_kind: 'user',
    full_name: 'must be discarded',
  };
  const recovered = plain(shared.sanitizeDiditActiveSessionList(
    { count: 1, results: [candidate] },
    config,
    key,
  ));
  assert.deepEqual(recovered, {
    sessionId: candidate.session_id,
    workflowId: config.workflowId,
    providerStatus: 'awaiting_user',
    hostedUrl: candidate.session_url,
  });
  assert.deepEqual(
    plain(shared.sanitizeDiditActiveSessionList(
      {
        count: 1,
        results: [{ ...candidate, workflow_id: undefined }],
      },
      config,
      key,
    )),
    recovered,
    'an omitted list-row workflow_id must inherit the exact request filter',
  );
  assert.doesNotMatch(JSON.stringify(recovered), /full_name|must be discarded/);
  assert.deepEqual(
    plain(shared.inspectDiditSessionList(
      { count: 0, results: [] },
      config,
      key,
    )),
    { kind: 'empty' },
  );

  assert.throws(
    () => shared.sanitizeDiditActiveSessionList(
      { count: 1, results: [{ ...candidate, status: 'Approved' }] },
      config,
      key,
    ),
    (error) => error?.name === 'DiditSessionNotResumableError',
  );
  for (const invalid of [
    { count: 2, results: [candidate, candidate] },
    { count: 1, results: [{ ...candidate, vendor_data: `kcf_${'e'.repeat(24)}` }] },
    {
      count: 1,
      results: [{
        ...candidate,
        workflow_id: '11111111-2222-4333-8444-666666666666',
      }],
    },
    { count: 1, results: [{ ...candidate, session_kind: 'business' }] },
    { count: 1, results: [{ ...candidate, session_kind: undefined, company_name: 'KYB' }] },
  ]) {
    assert.throws(() => shared.sanitizeDiditActiveSessionList(
      invalid,
      config,
      key,
    ));
  }
});

test('certification preflight is GET-only while start and recovery remain POST-only', () => {
  const api = bundled('supabase/functions/_shared/partners-api.ts');
  assert.deepEqual(
    plain(api.allowedMethodsForRoute('/kyc/certification/preflight')),
    ['GET'],
  );
  assert.deepEqual(
    plain(api.allowedMethodsForRoute('/kyc/certification')),
    ['POST'],
  );
  assert.deepEqual(
    plain(api.allowedMethodsForRoute('/kyc/certification/resume')),
    ['POST'],
  );
  assert.equal(
    api.PARTNERS_RPC.kycCertificationBindingMatch,
    'partners_service_kyc_certification_binding_match',
  );
  assert.equal(
    api.PARTNERS_RPC.kycCertificationCreateClaim,
    'partners_service_kyc_certification_create_claim',
  );
  assert.equal(
    api.PARTNERS_RPC.kycCertificationPreflight,
    'admin_partners_kyc_certification_preflight',
  );
  assert.throws(() => api.assertValidPreflight(
    'https://norva.tv',
    'GET',
    'authorization, content-type',
    ['https://norva.tv'],
    api.allowedMethodsForRoute('/kyc/certification'),
  ));
  api.assertValidPreflight(
    'https://norva.tv',
    'POST',
    'authorization, content-type, idempotency-key',
    ['https://norva.tv'],
    api.allowedMethodsForRoute('/kyc/certification'),
  );
  api.assertValidPreflight(
    'https://norva.tv',
    'POST',
    'authorization, content-type',
    ['https://norva.tv'],
    api.allowedMethodsForRoute('/kyc/certification/resume'),
  );

  const member = read('supabase/functions/norva-partners/index.ts');
  const preflightStart = member.indexOf(
    'route === "/kyc/certification/preflight"',
  );
  const routeStart = member.indexOf('route === "/kyc/certification"');
  const routeEnd = member.indexOf('route === "/referral/claim"', routeStart);
  const route = member.slice(routeStart, routeEnd);
  const helperStart = member.indexOf('async function createCertificationHostedSession');
  const helperEnd = member.indexOf('async function readJsonBody', helperStart);
  const helper = member.slice(helperStart, helperEnd);
  const listStart = member.indexOf('async function listCertificationHostedSessions');
  const recoveryStart = member.indexOf('async function recoverCertificationHostedSession');
  const claimStart = member.indexOf('async function claimCertificationCreateDispatch');
  const list = member.slice(listStart, recoveryStart);
  const recovery = member.slice(recoveryStart, claimStart);
  const claim = member.slice(claimStart, helperStart);
  assert.ok(preflightStart >= 0 && routeStart > preflightStart);
  assert.match(
    member.slice(preflightStart, routeStart),
    /PARTNERS_RPC\.kycCertificationPreflight/,
  );
  assert.match(
    member.slice(preflightStart, routeStart),
    /provider_configured:[\s\S]*certification_window_open:/,
  );
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  assert.ok(
    listStart >= 0 && recoveryStart > listStart && claimStart > recoveryStart,
  );
  assert.ok(
    member.indexOf('requireUserId(token, admin)') < routeStart,
    'GoTrue validation must finish before the caller-scoped certification RPC',
  );
  assert.match(member, /const SUPABASE_ANON_KEY = Deno\.env\.get\("SUPABASE_ANON_KEY"\)/);
  assert.match(
    member,
    /Deno\.env\.get\("NORVA_PARTNERS_DIDIT_CERTIFICATION_ENABLED"\) === "true"/,
  );
  assert.ok(
    route.indexOf('if (!DIDIT_CERTIFICATION_ENABLED)') <
      route.indexOf('createCertificationHostedSession('),
    'the fail-closed kill switch must run before any provider call',
  );
  assert.match(route, /didit_certification_disabled/);
  assert.match(
    member,
    /createClient\(SUPABASE_URL, SUPABASE_ANON_KEY,[\s\S]*global:[\s\S]*Authorization: `Bearer \$\{token\}`/,
  );
  assert.match(route, /parseIdempotencyKey/);
  assert.match(route, /parseEmptyMutationInput\(await readJsonBody\(req\)\)/);
  assert.match(route, /createCallerClient\(token\)/);
  assert.match(
    route,
    /callRpcWithClient\([\s\S]*PARTNERS_RPC\.kycCertificationPrepare/,
  );
  assert.match(
    route,
    /callRpcWithClient\([\s\S]*PARTNERS_RPC\.kycCertificationResume/,
  );
  assert.doesNotMatch(route, /p_user_id/);
  assert.match(
    helper,
    /createDiditSession\([\s\S]{0,160}prepared\.certification\.key/,
  );
  assert.ok(
    helper.indexOf('prepared.certification.status === "pending"') >= 0 &&
      helper.indexOf('prepared.certification.status === "pending"') <
        helper.indexOf('createDiditSession('),
    'a local provider binding must fail closed before another Didit create',
  );
  assert.match(helper, /return await recoverCertificationHostedSession\([\s\S]*prepared,[\s\S]*inspection\.session/);
  assert.match(helper, /await listCertificationHostedSessions\(config, prepared\)/);
  assert.ok(
    helper.indexOf('listCertificationHostedSessions(config, prepared)') <
      helper.indexOf('claimCertificationCreateDispatch(prepared)') &&
      helper.indexOf('claimCertificationCreateDispatch(prepared)') <
        helper.indexOf('createDiditSession('),
    'the exact list and one-way SQL claim must precede the sole provider POST',
  );
  assert.equal(
    (helper.match(/createDiditSession\(/g) || []).length,
    1,
    'the certification helper must contain exactly one provider POST path',
  );
  const activeStart = helper.indexOf('if (inspection.kind === "active")');
  const activeEnd = helper.indexOf('if (!claim.claimed)', activeStart);
  const activeBranch = helper.slice(activeStart, activeEnd);
  assert.ok(activeStart >= 0 && activeEnd > activeStart);
  assert.doesNotMatch(activeBranch, /createDiditSession|method:\s*"POST"/);
  assert.match(activeBranch, /PARTNERS_RPC\.kycCertificationSessionRecord/);
  assert.match(
    activeBranch,
    /diditConfigFingerprint\([\s\S]*DIDIT_PARTNERS_WORKFLOW_VERSION/,
  );
  assert.match(activeBranch, /p_provider_session_id: inspection\.session\.sessionId/);
  assert.match(activeBranch, /p_provider_workflow_id: inspection\.session\.workflowId/);
  assert.match(
    activeBranch,
    /p_provider_workflow_version:[\s\S]*DIDIT_PARTNERS_WORKFLOW_VERSION/,
  );
  assert.ok(
    helper.indexOf('if (!claim.claimed)') < helper.indexOf('createDiditSession('),
    'an empty-list claim loser must fail before the provider POST',
  );
  assert.doesNotMatch(list, /createDiditSession|method:\s*"POST"/);
  assert.match(list, /method:\s*"GET"/);
  assert.match(list, /searchParams\.set\("vendor_data", prepared\.certification\.key\)/);
  assert.match(list, /searchParams\.set\("workflow_id", config\.workflowId\)/);
  assert.match(list, /searchParams\.set\("session_kind", "user"\)/);
  assert.match(list, /searchParams\.set\("limit", "2"\)/);
  assert.match(list, /readBoundedDiditResponseBody\(response, 32_768\)/);
  assert.match(list, /inspectDiditSessionList/);
  assert.match(list, /DiditSessionNotResumableError[\s\S]*409[\s\S]*request_in_progress/);
  assert.doesNotMatch(recovery, /createDiditSession|method:\s*"POST"/);
  assert.match(recovery, /PARTNERS_RPC\.kycCertificationBindingMatch/);
  assert.match(recovery, /p_provider_session_id: providerSession\.sessionId/);
  assert.doesNotMatch(claim, /createDiditSession|method:\s*"POST"/);
  assert.match(claim, /PARTNERS_RPC\.kycCertificationCreateClaim/);
  assert.match(claim, /sanitizeKycCertificationCreateClaimRpc/);
  const recoveryProjection = recovery.slice(recovery.indexOf('return {'));
  assert.doesNotMatch(
    recoveryProjection,
    /sessionId|workflowId|certification\.key|full_name|document|token/i,
  );
  assert.match(
    helper,
    /p_certification_key: prepared\.certification\.key/,
  );
  assert.doesNotMatch(`${route}${helper}`, /randomUUID|getRandomValues/);
  assert.match(helper, /PARTNERS_RPC\.kycCertificationSessionRecord/);
  assert.match(helper, /p_provider_config_fingerprint/);
  assert.match(helper, /p_provider_session_ttl_seconds/);
  const activeProjection = activeBranch.slice(activeBranch.indexOf('return {'));
  const finalProjection = helper.slice(helper.lastIndexOf('  return {'));
  const publicProjection = `${activeProjection}\n${finalProjection}`;
  assert.match(
    publicProjection,
    /verification:[\s\S]*provider: "didit"[\s\S]*status:[\s\S]*url:[\s\S]*expires_at:/,
  );
  assert.doesNotMatch(
    publicProjection,
    /sessionId|workflowId|configFingerprint|certification\.key|token/i,
  );
});

test('certification status is bounded, observable after closure and rechecks the remote-call race', () => {
  const migration = read(
    'supabase/migrations/20260803160730_partners_didit_certification_pre_gate.sql',
  );
  const admin = read('public/js/pages/AdminPage.js');
  assert.match(
    migration,
    /admin_partners_kyc_certification_status\(\)[\s\S]*partners_require_didit_certification_observer/,
  );
  assert.match(
    migration,
    /'environment', v_session\.provider_environment[\s\S]*'observed_at', v_session\.updated_at[\s\S]*'reason', case/,
  );
  assert.match(
    migration,
    /partners_service_kyc_certification_session_record\([\s\S]*perform affiliate_private\.partners_assert_didit_certification_pre_gate\(\)/,
  );
  assert.match(
    migration,
    /partners_require_didit_certification_operator\([\s\S]*partners_require_aal2\(p_operation\)[\s\S]*partners_assert_didit_certification_pre_gate/,
  );
  assert.match(admin, /admin_partners_kyc_certification_status/);
  assert.match(admin, /_partnersKycCertificationPollUntil = Date\.now\(\) \+ 60_000/);
  assert.match(admin, /kycCertification/);
  assert.match(admin, /provider_environment_mismatch[\s\S]*binding_conflict/);
  assert.doesNotMatch(
    admin.slice(
      admin.indexOf('_renderPartnersKycCertification(data)'),
      admin.indexOf('_renderPartnersFinance(data)'),
    ),
    /session_id|workflow_id|document_age|country_iso3|payload_hash/i,
  );
});

test('webhook falls back to certification only on member P0006 and stays sanitized', () => {
  const webhook = read(
    'supabase/functions/norva-partners-kyc-webhook/index.ts',
  );
  const memberCall = webhook.indexOf(
    '"partners_service_kyc_webhook_apply_and_enqueue_purge"',
  );
  const fallback = webhook.indexOf('error?.code === "P0006"', memberCall);
  const certificationCall = webhook.indexOf(
    '"partners_service_kyc_certification_webhook_apply_and_enqueue_purge"',
    fallback,
  );
  const errorHandling = webhook.indexOf('if (error) {', certificationCall);
  assert.ok(
    memberCall >= 0 && fallback > memberCall &&
      certificationCall > fallback && errorHandling > certificationCall,
  );
  assert.doesNotMatch(
    webhook.slice(memberCall, fallback),
    /kyc_certification_webhook_apply_and_enqueue_purge/,
  );
  assert.match(
    webhook.slice(errorHandling, errorHandling + 700),
    /error\.code === "P0006"[\s\S]*webhook_resource_unknown/,
  );
  assert.match(webhook, /sanitizeKycCertificationWebhookRpc\(data\)/);
  assert.doesNotMatch(
    webhook,
    /console\[[^\]]+\]\([^)]*(?:rawBody|event|session|decision|document|payload)/s,
  );
});

test('terminal Didit evidence atomically enters the durable deletion outbox', () => {
  const webhook = read(
    'supabase/functions/norva-partners-kyc-webhook/index.ts',
  );
  const shared = read('supabase/functions/_shared/didit-partners.ts');
  assert.match(webhook, /encryptDiditPurgeEnvelope/);
  assert.match(webhook, /p_provider_session_envelope: providerSessionEnvelope/);
  assert.match(
    webhook,
    /partners_service_kyc_webhook_apply_and_enqueue_purge/,
  );
  assert.match(
    webhook,
    /partners_service_kyc_certification_webhook_apply_and_enqueue_purge/,
  );
  assert.match(
    shared,
    /DIDIT_SESSION_DELETE_URL_PREFIX[\s\S]*\/delete\/[\s\S]*method: "DELETE"[\s\S]*redirect: "error"/,
  );
  assert.match(shared, /response\.status === 204[\s\S]*response\.status === 404/);
  assert.doesNotMatch(
    webhook,
    /console\[[^\]]+\]\([^)]*(?:providerSessionId|apiKey)/s,
  );
});
