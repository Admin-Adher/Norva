'use strict';

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
const cloudSource = read('public/js/cloudApi.js');
const migrationSource = read(
  'supabase/migrations/20260802150931_partners_access_requests.sql',
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function requestState(overrides = {}) {
  return {
    exists: true,
    status: 'requested',
    country_code: 'US',
    subdivision_code: null,
    requested_at: '2026-08-02T12:00:00Z',
    reviewed_at: null,
    ...overrides,
  };
}

function programPreview(overrides = {}) {
  return {
    commission_rate_bps: 2000,
    attribution_window_days: 30,
    maturation_days: 45,
    payout_thresholds: { USD: 1000 },
    ...overrides,
  };
}

function getEnvelope(state = requestState()) {
  return {
    version: '2026-07-29',
    correlationId: 'access-request-contract',
    data: {
      schema_version: 1,
      program_preview: programPreview(),
      request: state,
    },
  };
}

function mutationEnvelope(state = requestState()) {
  const nextAction = state.status === 'requested'
    ? 'await_review'
    : state.status === 'approved'
      ? 'access_approved'
      : 'contact_support';
  return {
    version: '2026-07-29',
    correlationId: 'access-request-mutation-contract',
    data: {
      schema_version: 1,
      action: 'access_requested',
      replayed: false,
      program_preview: programPreview(),
      request: state,
      next_action: nextAction,
    },
  };
}

function loadCloudApi(payload) {
  const requests = [];
  const values = new Map([['norva-cloud-token', 'member-access-token']]);
  const localStorage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  const window = {
    NORVA_PARTNERS_API_URL: 'https://api.norva.tv/functions/v1/norva-partners',
    location: { origin: 'https://norva.tv', search: '', replace() {} },
  };
  const context = vm.createContext({
    window,
    localStorage,
    navigator: { userAgent: 'Norva access request test', language: 'en-US', languages: ['en-US'] },
    document: { readyState: 'loading', addEventListener() {} },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'application/json' : null },
        json: async () => clone(typeof payload === 'function' ? payload(url, options) : payload),
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
  return { cloud: window.NorvaCloud, requests };
}

test('access-request input is exact, bounded and contains no client authority field', () => {
  const { mapDatabaseError, parseAccessRequestInput } = helpers();
  assert.deepEqual(
    clone(parseAccessRequestInput({ countryCode: 'us', subdivisionCode: 'us-ca' })),
    { countryCode: 'US', subdivisionCode: 'US-CA' },
  );
  assert.throws(() => parseAccessRequestInput({ countryCode: 'US', source: 'admin_web' }));
  assert.throws(() => parseAccessRequestInput({ countryCode: 'US', subdivisionCode: 'CA-ON' }));
  assert.throws(() => parseAccessRequestInput({ countryCode: 'USA' }));
  assert.deepEqual(clone(mapDatabaseError({ code: 'P0008' }, 'mutation')), {
    status: 429,
    code: 'rate_limited',
    message: 'Too many access requests were received. Try again later.',
  });
});

test('access-request sanitizers accept only the exact non-financial state machine', () => {
  const {
    sanitizeAccessRequestData,
    sanitizeAccessRequestMutationData,
  } = helpers();
  const empty = {
    schema_version: 1,
    program_preview: null,
    request: {
      exists: false,
      status: null,
      country_code: null,
      subdivision_code: null,
      requested_at: null,
      reviewed_at: null,
    },
  };
  assert.deepEqual(clone(sanitizeAccessRequestData(empty)), empty);
  assert.deepEqual(
    clone(sanitizeAccessRequestMutationData(mutationEnvelope().data)),
    mutationEnvelope().data,
  );
  const approved = mutationEnvelope(requestState({
    status: 'approved',
    reviewed_at: '2026-08-02T13:00:00Z',
  })).data;
  assert.deepEqual(clone(sanitizeAccessRequestMutationData(approved)), approved);

  const impossible = clone(approved);
  impossible.request.reviewed_at = null;
  assert.throws(() => sanitizeAccessRequestMutationData(impossible));
  const injected = clone(mutationEnvelope().data);
  injected.request.user_id = '21000000-0000-4000-8000-000000000002';
  assert.throws(() => sanitizeAccessRequestMutationData(injected));
  const commercialDrift = clone(mutationEnvelope().data);
  commercialDrift.program_preview.commission_rate_bps = 3000;
  assert.throws(() => sanitizeAccessRequestMutationData(commercialDrift));
  const thresholdDrift = clone(mutationEnvelope().data);
  thresholdDrift.program_preview.payout_thresholds.USD = 999;
  assert.throws(() => sanitizeAccessRequestMutationData(thresholdDrift));
});

test('Edge exposes authenticated GET and kill-switched idempotent POST without accepting user authority', () => {
  const { allowedMethodsForRoute } = helpers();
  assert.deepEqual(clone(allowedMethodsForRoute('/access-request')), ['GET', 'POST']);
  assert.match(edgeSource, /requireUserId\(token, admin\)/);
  assert.match(edgeSource, /PARTNERS_RPC\.accessRequestGet/);
  assert.match(edgeSource, /PARTNERS_RPC\.accessRequestSubmit/);
  assert.match(edgeSource, /NORVA_PARTNERS_ACCESS_REQUESTS_ENABLED/);
  assert.match(edgeSource, /partners_access_requests_disabled/);
  assert.match(edgeSource, /problem\.code === "rate_limited"[\s\S]{0,100}"Retry-After": "60"/);
  assert.match(edgeSource, /p_user_id: userId/);
  assert.match(edgeSource, /parseAccessRequestInput\(await readJsonBody\(req\)\)/);
  assert.doesNotMatch(edgeSource, /p_user_id:\s*input\./);
  assert.doesNotMatch(edgeSource, /p_source|input\.source/);
});

test('cloudApi GET and POST use the exact account-scoped access-request contract', async () => {
  let invocation = 0;
  const { cloud, requests } = loadCloudApi(() => {
    invocation += 1;
    return invocation === 1 ? getEnvelope() : mutationEnvelope();
  });
  const controller = new AbortController();
  const current = await cloud.partners.accessRequest.get({ signal: controller.signal });
  const submitted = await cloud.partners.accessRequest.request({
    countryCode: 'us',
    subdivisionCode: 'us-ca',
    idempotencyKey: 'norva.access.1234567890abcdef',
  });

  assert.equal(current.data.request.status, 'requested');
  assert.equal(current.data.program_preview.commission_rate_bps, 2000);
  assert.equal(submitted.data.next_action, 'await_review');
  assert.equal(Object.isFrozen(submitted.data.request), true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://api.norva.tv/functions/v1/norva-partners/access-request');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.signal, controller.signal);
  assert.equal(requests[1].options.method, 'POST');
  assert.equal(requests[1].options.headers['Idempotency-Key'], 'norva.access.1234567890abcdef');
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    countryCode: 'US',
    subdivisionCode: 'US-CA',
  });
  assert.equal(Object.hasOwn(JSON.parse(requests[1].options.body), 'userId'), false);
  assert.equal(Object.hasOwn(JSON.parse(requests[1].options.body), 'source'), false);
});

test('migration keeps request, enrollment and payment authority separated', () => {
  assert.match(migrationSource, /create table affiliate_private\.affiliate_access_requests/);
  assert.match(migrationSource, /enable row level security/);
  assert.match(migrationSource, /revoke all on table affiliate_private\.affiliate_access_requests[\s\S]*service_role/);
  assert.match(migrationSource, /grant execute on function public\.partners_service_access_request_submit[\s\S]*to service_role/);
  assert.match(migrationSource, /partners_require_capability\('risk'\)/);
  assert.match(migrationSource, /partners_require_aal2\([\s\S]*Partners access request decision/);
  assert.match(migrationSource, /perform public\.admin_partners_control\([\s\S]*'set_allowlist'/);
  assert.match(migrationSource, /affiliate_service_idempotency_operation_v2[\s\S]*not valid/);
  assert.match(migrationSource, /validate constraint affiliate_service_idempotency_operation_v2/);
  assert.match(migrationSource, /created_at < now\(\) - interval '30 days'/);
  assert.match(migrationSource, /v_recent_attempts >= 8/);
  assert.match(migrationSource, /created_at >= now\(\) - interval '60 seconds'/);
  assert.match(migrationSource, /errcode = 'P0008'/);

  const getBody = migrationSource.slice(
    migrationSource.indexOf('create or replace function affiliate_private.partners_service_access_request_get'),
    migrationSource.indexOf('create or replace function affiliate_private.partners_service_access_request_submit'),
  );
  assert.doesNotMatch(
    getBody,
    /partners_enabled|partners_invite_only|admin_feature_flags|affiliate_release_gates/,
  );

  const submitBody = migrationSource.slice(
    migrationSource.indexOf('create or replace function affiliate_private.partners_service_access_request_submit'),
    migrationSource.indexOf('create or replace function affiliate_private.admin_partners_access_requests'),
  );
  assert.doesNotMatch(submitBody, /insert into affiliate_private\.affiliate_accounts/);
  assert.doesNotMatch(submitBody, /affiliate_pilot_allowlist/);
  assert.doesNotMatch(submitBody, /partners_enabled|partners_invite_only/);
  assert.doesNotMatch(submitBody, /admin_feature_flags[\s\S]*(insert|update|delete)/i);
  assert.doesNotMatch(submitBody, /affiliate_release_gates[\s\S]*(insert|update|delete)/i);
  assert.doesNotMatch(submitBody, /affiliate_(commissions|ledger|payout)/i);
});
