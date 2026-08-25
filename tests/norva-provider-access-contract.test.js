const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const EDGE_PATH = path.join(ROOT, 'supabase/functions/norva-provider-access/index.ts');
const EDGE = fs.readFileSync(EDGE_PATH, 'utf8').replace(/\r\n?/g, '\n');
const SUPABASE_CONFIG = fs.readFileSync(path.join(ROOT, 'supabase/config.toml'), 'utf8').replace(/\r\n?/g, '\n');
const EDGE_DEPLOY = fs.readFileSync(path.join(
  ROOT, 'ops/hetzner/scripts/04-deploy-edge-functions.sh',
), 'utf8').replace(/\r\n?/g, '\n');
const DIRECT_FALLBACK_MIGRATION = fs.readFileSync(path.join(
  ROOT,
  'supabase/migrations/20260823174000_provider_direct_fallback_source_lease.sql',
), 'utf8').replace(/\r\n?/g, '\n');
const TRANSITION_MIGRATION = fs.readFileSync(path.join(
  ROOT,
  'supabase/migrations/20260823120000_provider_credential_transition_v1.sql',
), 'utf8').replace(/\r\n?/g, '\n');

function section(start, end) {
  const from = EDGE.indexOf(start);
  assert.notEqual(from, -1, `missing section start: ${start}`);
  const to = EDGE.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return EDGE.slice(from, to);
}

function functionExpression(name, nextName) {
  const asyncMarker = `async function ${name}(`;
  const syncMarker = `function ${name}(`;
  const marker = EDGE.includes(asyncMarker) ? asyncMarker : syncMarker;
  const source = section(marker, `\n${nextName}(`);
  const declaration = source.slice(source.indexOf(marker));
  return declaration.replace(new RegExp(`^(async\\s+)?function\\s+${name}`), (_all, asyncPrefix) => `${asyncPrefix || ''}function`);
}

test('Provider Access Edge surface exposes credential candidates and durable catalog replacements', () => {
  assert.match(EDGE, /const API_VERSION = "provider-access\.norva\/v1"/);
  assert.match(EDGE, /parts\[0\] !== "v1"/);
  assert.match(EDGE, /parts\[3\] === "replacements"/);
  assert.match(EDGE, /parts\[3\] !== "credential-candidates"/);
  for (const action of ['decision', 'apply', 'cancel']) assert.ok(EDGE.includes(`"${action}"`));
  assert.ok(EDGE.includes('"promote"'));
  assert.ok(EDGE.includes('"rollback"'));
  assert.match(EDGE, /norva_create_source_replacement_from_candidate/);
  assert.match(EDGE, /norva_promote_source_replacement_v3/);
  assert.match(EDGE, /norva_rollback_source_replacement/);
  assert.match(EDGE, /norva_run_replacement_cleanup_batch/);
  assert.doesNotMatch(EDGE, /provider-access\/terms/);
});

test('replacement cleanup remains a bounded flag-independent terminal recovery lane', () => {
  const worker = section('async function handleWorkerDrain', '\nasync function claimCredentialTransitionJobs');
  const cleanup = worker.slice(worker.indexOf('if (jobs.length === 0)'));
  assert.match(cleanup, /norva_run_replacement_cleanup_batch/);
  assert.match(cleanup, /p_limit: 200/);
  assert.doesNotMatch(cleanup, /replacementEnabled/);
});

test('replacement build failures terminate through the replacement state machine', () => {
  const failure = section('async function failCredentialValidation', '\nconst MANIFEST_SEAL_BATCH_LIMIT');
  assert.match(failure, /job\.transitionKind === "replacement"/);
  assert.match(failure, /norva_get_source_replacement/);
  assert.match(failure, /norva_fail_source_replacement/);
  assert.match(failure, /operation: "fail_source_replacement"/);
});

test('every mutation fails closed on the feature flag and contract version before user business work', () => {
  const route = section('async function routeRequest', '\nfunction routeSegments');
  const postGate = route.indexOf('if (req.method === "POST")');
  assert.ok(postGate >= 0);
  assert.ok(route.indexOf('await requireCredentialFeatureFlag()', postGate) < route.indexOf('const user = await requireUserJwt', postGate));
  assert.ok(route.indexOf('requireContractVersion(req)', postGate) < route.indexOf('const user = await requireUserJwt', postGate));
  assert.match(EDGE, /if \(!await credentialFeatureFlagEnabled\(\)\) throw new ContractError\("FEATURE_DISABLED"\)/);
  assert.match(EDGE, /return !error && data === true/);
  assert.doesNotMatch(EDGE, /admin_flag_set|enabled:\s*true/);
});

test('user routes accept only a server-verified Supabase user JWT', () => {
  const auth = section('async function requireUserJwt', '\nasync function requireOwnedSource');
  assert.match(auth, /Authorization/);
  assert.match(auth, /admin\.auth\.getUser\(token\)/);
  assert.doesNotMatch(auth, /cloud_devices|device_token|requireDevice|user_metadata/);
  assert.match(auth, /AUTHENTICATION_REQUIRED/);
});

test('credential candidates are Xtream-only and a manually disabled nondeleted source remains manageable', () => {
  const ownership = section('async function requireOwnedSource', '\nasync function createCredentialCandidate');
  assert.match(ownership, /source_type/);
  assert.match(ownership, /!== "xtream"/);
  assert.match(ownership, /data\.deleted_at/);
  assert.doesNotMatch(ownership, /data\.enabled\s*===\s*false|!data\.enabled/);
  assert.doesNotMatch(ownership, /lifecycle\.catalog_visibility\s*!==/);
  assert.match(ownership, /lifecycle\.lifecycle_state !== "active"/);
});

test('completed replacements remain manageable through rollback without exposing hidden catalog rows', () => {
  const ownership = section('async function requireOwnedReplacementSource', '\nasync function createSourceReplacement');
  assert.match(ownership, /\["active", "replaced"\]/);
  assert.doesNotMatch(ownership, /cloud_media_items|cloud_title_variants|config_ciphertext.*return/);
  const rollback = section('async function rollbackSourceReplacement', '\nfunction boundedDisplayName');
  assert.match(rollback, /snapshot\.state !== "COMPLETED"/);
  assert.match(rollback, /Date\.parse\(snapshot\.rollbackUntil\) <= Date\.now\(\)/);
  assert.match(rollback, /lifecycle_state !== "active"/);
  assert.match(rollback, /catalog_visibility !== "visible"/);
  assert.match(rollback, /norva_rollback_source_replacement/);
  assert.match(rollback, /p_expected_active_source_revision/);
});

test('POST preconditions use strict idempotency and quoted source/transition ETags', () => {
  assert.match(EDGE, /req\.headers\.get\("Idempotency-Key"\)/);
  assert.match(EDGE, /req\.headers\.get\("If-Match"\)/);
  assert.match(EDGE, /\^"\$\{kind\}-rev-/);
  assert.match(EDGE, /PRECONDITION_REQUIRED/);
  assert.match(EDGE, /p_idempotency_key: idempotencyKey/);
  assert.match(EDGE, /p_request_fingerprint: fingerprint/);
  assert.match(EDGE, /p_expected_transition_revision/);
  assert.match(EDGE, /p_expected_source_revision/);
});

test('candidate secrets are AES-GCM encrypted and request fingerprints are keyed HMACs', () => {
  const cryptoBlock = section('async function encryptSourceConfig', '\nasync function handleWorkerDrain');
  assert.match(cryptoBlock, /AES-GCM/);
  assert.match(cryptoBlock, /aesgcm\.v1\./);
  assert.match(cryptoBlock, /name: "HMAC", hash: "SHA-256"/);
  assert.match(cryptoBlock, /provider-access-fingerprint-v1/);
  assert.doesNotMatch(cryptoBlock, /subtle\.digest\("SHA-256", encoder\.encode\(canonicalJson/);
});

test('create stores only ciphertext through the transactional RPC and never updates the active source', () => {
  const create = section('async function createCredentialCandidate', '\nasync function getCredentialCandidate');
  assert.match(create, /encryptSourceConfig/);
  assert.match(create, /norva_create_credential_transition/);
  assert.doesNotMatch(create, /norva_bind_credential_transition_account_affinity/);
  assert.match(create, /p_candidate_config_ciphertext: ciphertext/);
  assert.match(create, /p_candidate_config_hint: candidateHint/);
  assert.match(create, /p_candidate_account_affinity_hash: candidateAccountAffinityHash/);
  assert.match(create, /atomicCreate: true/);
  assert.doesNotMatch(create, /\.from\("cloud_sources"\)|\.update\s*\(/);
  assert.match(create, /CredentialCandidate/);
  assert.match(create, /202/);
});

test('atomic create caller stays aligned with the exact SQL overload', () => {
  assert.match(DIRECT_FALLBACK_MIGRATION, /create or replace function public\.norva_create_credential_transition\(\s*p_user_id uuid,\s*p_source_id uuid,\s*p_idempotency_key text,\s*p_request_fingerprint text,\s*p_if_match_revision bigint,\s*p_candidate_config_ciphertext text,\s*p_candidate_config_hint jsonb,\s*p_actor text,\s*p_candidate_account_affinity_hash text\s*\) returns jsonb/i);
  const create = section('async function createCredentialCandidate', '\nasync function getCredentialCandidate');
  for (const parameter of [
    'p_user_id', 'p_source_id', 'p_idempotency_key', 'p_request_fingerprint',
    'p_if_match_revision', 'p_candidate_config_ciphertext', 'p_candidate_config_hint',
    'p_actor', 'p_candidate_account_affinity_hash',
  ]) assert.match(create, new RegExp(`\\b${parameter}\\b`), parameter);
  assert.equal((create.match(/await rpc\("norva_create_credential_transition"/g) ?? []).length, 1);
  assert.doesNotMatch(create, /bind_credential_transition_account_affinity/);
});

test('create passes an exact bounded candidate hint without URL, username, password, token, or stale sync fields', async () => {
  const create = section('async function createCredentialCandidate', '\nasync function getCredentialCandidate');
  const hint = section('function candidateConfigHint', '\nfunction normalizeServerUrl');
  const rpcCalls = [];
  const createCredentialCandidate = vm.runInNewContext(`(() => {
    ${create}
    ${hint}
    return createCredentialCandidate;
  })()`, {
    URL,
    ContractError: class ContractError extends Error {},
    requireIdempotencyKey: () => 'idempotency-key-123',
    parseEntityTag: () => 7,
    readJsonObject: async () => ({}),
    normalizeCandidateConfig: () => ({
      serverUrl: 'https://Panel.Example.test:8443/base',
      username: 'private-user',
      password: 'private-pass',
    }),
    getRuntimeConfig: async () => ({ sourceConfigKey: 'key' }),
    encryptSourceConfig: async () => 'aesgcm.v1.ciphertext',
    keyedFingerprint: async () => 'f'.repeat(64),
    credentialAccountAffinityHash: async () => 'a'.repeat(64),
    rpc: async (name, params) => {
      rpcCalls.push({ name, params });
      return { transitionId: 'candidate-id', sourceId: 'source-id', revision: 1 };
    },
    sanitizeCredentialCandidate: () => ({ revision: 1, candidateId: 'candidate-id' }),
    successResponse: (_req, _requestId, _kind, value) => value,
    transitionTag: () => '"transition-rev-1"',
    candidateLocation: () => '/candidate',
  });
  await createCredentialCandidate({}, 'request-id', { id: 'user-id', actor: 'user:user-id' }, { id: 'source-id' });
  assert.equal(rpcCalls[0].name, 'norva_create_credential_transition');
  assert.deepEqual(JSON.parse(JSON.stringify(rpcCalls[0].params.p_candidate_config_hint)), {
    sourceType: 'xtream', serverHost: 'panel.example.test:8443', hasPassword: true,
  });
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].params.p_candidate_account_affinity_hash, 'a'.repeat(64));
  const serialized = JSON.stringify(rpcCalls[0].params.p_candidate_config_hint);
  assert.doesNotMatch(serialized, /private|https?:|username|serverUrl|token|cursor|signature|status/i);
  assert.equal(Object.hasOwn(rpcCalls[0].params.p_candidate_config_hint, 'password'), false);
});

test('candidate creation blocked by an active direct-fallback lease is a strict retryable 503', async () => {
  const create = section('async function createCredentialCandidate', '\nasync function getCredentialCandidate');
  const rpcBlock = section('async function rpc', '\nasync function getRuntimeConfig');
  class ContractError extends Error {
    constructor(code) {
      super(code);
      this.code = code;
      this.status = code === 'PROVIDER_CHECK_TEMPORARY_FAILURE' ? 503 : 500;
      this.retryable = code === 'PROVIDER_CHECK_TEMPORARY_FAILURE';
    }
  }
  const { createCredentialCandidate, mapRpcError } = vm.runInNewContext(`(() => {
    ${create}
    ${rpcBlock}
    return { createCredentialCandidate, mapRpcError };
  })()`, {
    ContractError,
    admin: {
      rpc: async () => ({
        data: null,
        error: {
          code: '55P03',
          message: 'source direct fallback lease blocks transition creation',
          details: 'reason=direct_fallback_lease_active',
        },
      }),
    },
    requireIdempotencyKey: () => 'idempotency-key-lease',
    parseEntityTag: () => 7,
    readJsonObject: async () => ({}),
    normalizeCandidateConfig: () => ({
      serverUrl: 'https://provider.example', username: 'hidden', password: 'hidden',
    }),
    candidateConfigHint: () => ({ sourceType: 'xtream', serverHost: 'provider.example', hasPassword: true }),
    credentialAccountAffinityHash: async () => 'a'.repeat(64),
    getRuntimeConfig: async () => ({ sourceConfigKey: 'key' }),
    encryptSourceConfig: async () => 'aesgcm.v1.ciphertext',
    keyedFingerprint: async () => 'f'.repeat(64),
  });

  await assert.rejects(
    createCredentialCandidate({}, 'request-id', { id: 'user-id', actor: 'user:user-id' }, { id: 'source-id' }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_CHECK_TEMPORARY_FAILURE');
      assert.equal(error.status, 503);
      assert.equal(error.retryable, true);
      assert.equal(error.message.includes('direct_fallback'), false);
      return true;
    },
  );
  const unrelated = mapRpcError({
    code: '55P03',
    details: 'reason=unrelated_lock',
    message: 'lock not available',
  });
  assert.equal(unrelated.code, 'INVARIANT_VIOLATION');
  assert.equal(unrelated.retryable, false);
  const accountConflict = mapRpcError({
    code: '55P03',
    details: 'reason=account_transition_active',
    message: 'provider account transition is already active',
  }, { atomicCreate: true });
  assert.equal(accountConflict.code, 'TRANSITION_ALREADY_PENDING');
  assert.equal(accountConflict.retryable, false);
  const affinityMissing = mapRpcError({
    code: '55000',
    details: 'reason=affinity_missing',
    message: 'credential transition account affinity is unavailable',
  }, { atomicCreate: true });
  assert.equal(affinityMissing.code, 'PROVIDER_CHECK_TEMPORARY_FAILURE');
  assert.equal(affinityMissing.retryable, true);
});

test('atomic create never falls back on DB-old and idempotent retries reuse one exact RPC shape', async () => {
  const create = section('async function createCredentialCandidate', '\nasync function getCredentialCandidate');
  const rpcBlock = section('async function rpc', '\nasync function getRuntimeConfig');
  class ContractError extends Error {
    constructor(code) {
      super(code);
      this.code = code;
      this.status = code === 'PROVIDER_CHECK_TEMPORARY_FAILURE' ? 503 : 500;
      this.retryable = code === 'PROVIDER_CHECK_TEMPORARY_FAILURE';
    }
  }
  const calls = [];
  let response = {
    data: { transitionId: 'candidate-id', sourceId: 'source-id', revision: 1 },
    error: null,
  };
  const createCredentialCandidate = vm.runInNewContext(`(() => {
    ${create}
    ${rpcBlock}
    return createCredentialCandidate;
  })()`, {
    ContractError,
    admin: { rpc: async (name, params) => { calls.push({ name, params }); return response; } },
    requireIdempotencyKey: () => 'same-idempotency-key',
    parseEntityTag: () => 7,
    readJsonObject: async () => ({}),
    normalizeCandidateConfig: () => ({
      serverUrl: 'https://provider.example', username: 'hidden', password: 'hidden',
    }),
    candidateConfigHint: () => ({ sourceType: 'xtream', serverHost: 'provider.example', hasPassword: true }),
    credentialAccountAffinityHash: async () => 'a'.repeat(64),
    getRuntimeConfig: async () => ({ sourceConfigKey: 'key' }),
    encryptSourceConfig: async () => 'aesgcm.v1.ciphertext',
    keyedFingerprint: async () => 'f'.repeat(64),
    sanitizeCredentialCandidate: () => ({ revision: 1, candidateId: 'candidate-id' }),
    successResponse: (_req, _requestId, _kind, value) => value,
    transitionTag: () => '"transition-rev-1"',
    candidateLocation: () => '/candidate',
  });

  const args = [{}, 'request-id', { id: 'user-id', actor: 'user:user-id' }, { id: 'source-id' }];
  await createCredentialCandidate(...args);
  await createCredentialCandidate(...args);
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), JSON.parse(JSON.stringify(calls[1])));
  assert.equal(calls[0].name, 'norva_create_credential_transition');
  assert.equal(calls[0].params.p_candidate_account_affinity_hash, 'a'.repeat(64));
  assert.equal(JSON.stringify(calls).includes('norva_bind_credential_transition_account_affinity'), false);

  response = { data: null, error: { code: 'PGRST202', message: 'function overload not found', details: '' } };
  await assert.rejects(createCredentialCandidate(...args), (error) => {
    assert.equal(error.code, 'PROVIDER_CHECK_TEMPORARY_FAILURE');
    assert.equal(error.status, 503);
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(calls.at(-1).name, 'norva_create_credential_transition');
  assert.equal(JSON.stringify(calls.at(-1)).includes('bind_credential'), false);
});

test('public candidate projection is allowlisted and never returns secrets or raw evidence', () => {
  const sanitizer = section('function sanitizeCredentialCandidate', '\nfunction candidateActions');
  for (const key of ['candidateId', 'sourceId', 'state', 'comparison', 'revision', 'sourceRevision', 'actions']) {
    assert.match(sanitizer, new RegExp(`\\b${key}\\b`));
  }
  assert.doesNotMatch(sanitizer, /ciphertext|password|username|serverUrl|sample|overlap|secondarySignals|details/i);
  const response = section('function successResponse', '\nfunction normalizePublicError');
  assert.match(response, /apiVersion: API_VERSION/);
  assert.match(response, /error: \{ code: error\.code, message: error\.message, retryable: error\.retryable \}/);
  assert.doesNotMatch(response, /details|stack|cause/);
  assert.match(EDGE, /"Cache-Control": "no-store"/);
});

test('gateway transport has a fixed read-only action allowlist and no direct-provider fallback', () => {
  for (const action of [
    'account_info', 'get_live_categories', 'get_vod_categories', 'get_series_categories',
    'get_live_streams', 'get_vod_streams', 'get_series',
  ]) assert.ok(EDGE.includes(`"${action}"`), action);
  const gateway = section('async function gatewayAccountInfo', '\nfunction assertAuthenticatedAccount');
  assert.match(gateway, /"\/xtream\/metadata"/);
  assert.match(gateway, /"\/xtream\/metadata-page"/);
  assert.match(gateway, /GATEWAY_PAGE_ACTIONS\.includes\(request\.action\)/);
  assert.match(gateway, /spoolKey/);
  assert.match(gateway, /gatewayPending/);
  assert.doesNotMatch(gateway, /player_api\.php|xtreamApiUrl|fetchJson|fallback|config\.serverUrl\}\//i);
  assert.doesNotMatch(EDGE, /driveXtreamSyncToReady/);
});

test('gateway runtime call sends secrets only to the configured gateway and sanitizes failures', async () => {
  const source = section('async function gatewayAccountInfo', '\nasync function gatewayMetadataPage');
  const requestSource = section('async function gatewayRequestJson', '\nfunction boundedGatewayCursor');
  const readSource = section('async function readBoundedGatewayJson', '\nfunction assertAuthenticatedAccount');
  const calls = [];
  class WorkerFault extends Error {
    constructor(queueCode, retryable, publicCode = 'PROVIDER_CHECK_TEMPORARY_FAILURE') {
      super(publicCode); this.queueCode = queueCode; this.retryable = retryable; this.publicCode = publicCode;
    }
  }
  const gatewayAccountInfo = vm.runInNewContext(`(() => {
    ${source}
    ${requestSource}
    ${readSource}
    return gatewayAccountInfo;
  })()`, {
    WorkerFault,
    GATEWAY_REQUEST_TIMEOUT_MS: 120_000,
    MAX_GATEWAY_ACCOUNT_BYTES: 1024 * 1024,
    AbortController,
    TextDecoder,
    Uint8Array,
    setTimeout,
    clearTimeout,
    isRecord: (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ user_info: { auth: 1 } }), {
        status: 200,
        headers: { 'content-length': '24' },
      });
    },
    JSON,
    Number,
    Error,
  });
  const config = { serverUrl: 'https://provider.invalid', username: 'private-user', password: 'private-pass' };
  await gatewayAccountInfo({ mediaGatewayUrl: 'https://gateway.example', mediaGatewayToken: 'gateway-token' }, config);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://gateway.example/xtream/metadata');
  assert.equal(new URL(calls[0].url).hostname, 'gateway.example');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer gateway-token');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    serverUrl: config.serverUrl,
    username: config.username,
    password: config.password,
    action: 'account_info',
    params: {},
    userAgent: 'NorvaProviderAccess/1.0',
  });
});

test('gateway failure classification separates credential rejection, gateway/proxy auth, and provider pressure', () => {
  class WorkerFault extends Error {
    constructor(queueCode, retryable, publicCode = 'PROVIDER_CHECK_TEMPORARY_FAILURE') {
      super(publicCode); this.queueCode = queueCode; this.retryable = retryable; this.publicCode = publicCode;
    }
  }
  const classifierSource = section('function gatewayFailureForResponse', '\nfunction boundedGatewayCursor');
  const accountSource = section('function assertAuthenticatedAccount', '\nasync function workerRpc');
  const safeCodes = new Set([
    'PROVIDER_REQUEST_FAILED', 'PROVIDER_BUSY', 'PROVIDER_MULTI_IP', 'PROVIDER_RATE_LIMIT',
    'PROXY_AUTH_FAILED', 'PROVIDER_RESPONSE_TOO_LARGE',
    'account_busy', 'background_busy', 'viewer_preempted', 'catalog_cursor_stale',
  ]);
  const harness = vm.runInNewContext(`(() => {
    ${classifierSource}
    ${accountSource}
    return { gatewayFailureForResponse, assertAuthenticatedAccount };
  })()`, {
    WorkerFault,
    GATEWAY_SAFE_ERROR_CODES: safeCodes,
    isRecord: (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
    String,
  });
  assert.throws(
    () => harness.assertAuthenticatedAccount({ user_info: { auth: 0 } }),
    (error) => error.queueCode === 'auth_rejected' && error.retryable === false,
  );
  const provider401 = harness.gatewayFailureForResponse(401, { code: 'PROVIDER_REQUEST_FAILED' });
  assert.equal(provider401.queueCode, 'auth_rejected');
  assert.equal(provider401.retryable, false);
  const gateway401 = harness.gatewayFailureForResponse(401, {});
  assert.equal(gateway401.queueCode, 'internal_error');
  assert.equal(gateway401.retryable, false);
  const proxyAuth = harness.gatewayFailureForResponse(502, { code: 'PROXY_AUTH_FAILED' });
  assert.equal(proxyAuth.queueCode, 'provider_unavailable');
  assert.equal(proxyAuth.retryable, true);
  for (const [status, code] of [[458, 'PROVIDER_BUSY'], [409, 'account_busy']]) {
    const pressure = harness.gatewayFailureForResponse(status, { code });
    assert.equal(pressure.queueCode, 'rate_limited');
    assert.equal(pressure.retryable, true);
  }
  const oversized = harness.gatewayFailureForResponse(502, { code: 'PROVIDER_RESPONSE_TOO_LARGE' });
  assert.equal(oversized.queueCode, 'provider_unavailable');
  assert.equal(oversized.retryable, true);
  const stale = harness.gatewayFailureForResponse(409, { code: 'catalog_cursor_stale' });
  assert.equal(stale.queueCode, 'catalog_changed_during_build');
  assert.equal(stale.retryable, false);
});

test('gateway 202 becomes one cursorless pending signal with a bounded retry delay', async () => {
  const source = section('async function gatewayMetadataPage', '\nasync function gatewayRequestJson');
  const gatewayMetadataPage = vm.runInNewContext(`(() => { ${source}; return gatewayMetadataPage; })()`, {
    GATEWAY_PAGE_ACTIONS: ['get_vod_streams'],
    Number,
    String,
    WorkerFault: class WorkerFault extends Error {},
    keyedFingerprint: async () => 'spool-key',
    gatewayRequestJson: async () => ({ gatewayPending: true, retryAfterSeconds: 7 }),
    MAX_GATEWAY_PAGE_BYTES: 1024,
  });
  const result = await gatewayMetadataPage(
    { sourceConfigKey: 'key' },
    { serverUrl: 'https://provider.test', username: 'user', password: 'pass' },
    { transitionId: 'transition' },
    'generation',
    { action: 'get_vod_streams', categoryId: null, cursor: null, spoolToken: null, maxItems: 250 },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    items: [], done: false, pending: true, retryAfterSeconds: 7, nextCursor: null, spoolToken: null,
  });
  const retrySource = section('function boundedGatewayRetryAfter', '\nfunction gatewayFailureForResponse');
  const boundedGatewayRetryAfter = vm.runInNewContext(`(() => { ${retrySource}; return boundedGatewayRetryAfter; })()`, {
    Number,
    WorkerFault: class WorkerFault extends Error {},
  });
  assert.equal(boundedGatewayRetryAfter('60'), 60);
  assert.throws(() => boundedGatewayRetryAfter('61'));
  assert.throws(() => boundedGatewayRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT'));
});

test('post-switch completion is fenced by a durable active refresh proof', () => {
  const verify = section('async function verifyPostSwitchJob', '\nasync function restoreAfterPostSwitchFailure');
  assert.match(verify, /runActivePostSwitchRefresh/);
  assert.match(verify, /p_refresh_proof_id: refresh\.refreshProofId/);
  assert.doesNotMatch(verify, /p_refresh_proof_id: crypto\.randomUUID\(\)/);
  const refresh = section('async function runActivePostSwitchRefresh', '\nfunction rpcObject');
  for (const rpc of [
    'norva_get_catalog_write_snapshot',
    'norva_begin_active_catalog_title_projection_refresh',
    'norva_upsert_active_catalog_media_items',
    'norva_upsert_active_catalog_title_payloads',
    'norva_upsert_active_catalog_title_variants',
    'norva_upsert_active_catalog_live_materialization',
    'norva_prune_active_catalog_refresh_action_batch',
    'norva_reconcile_active_catalog_title_projection_batch',
    'norva_mark_active_catalog_title_projection_refreshed',
  ]) assert.match(refresh, new RegExp(rpc));
  const checkpoint = section('async function checkpointActiveRefresh', '\nfunction cleanActiveSpoolToken');
  assert.match(checkpoint, /norva_checkpoint_active_catalog_title_refresh/);
  assert.match(checkpoint, /p_requeue: requeue/);
  const digestBinding = refresh.indexOf('const boundCheckpoint = await checkpointActiveRefresh');
  const firstActiveWriter = refresh.indexOf('norva_upsert_active_catalog_refresh_categories');
  assert.ok(digestBinding >= 0 && firstActiveWriter >= 0 && digestBinding < firstActiveWriter,
    'the signed spool digest is checkpointed before any active catalogue writer');
  const pruneContinuation = refresh.slice(
    refresh.indexOf('if (state.actionComplete)'),
    refresh.indexOf('const page = await gatewayMetadataPage'),
  );
  assert.match(pruneContinuation, /let visibilityEpoch = fence\.p_user_visibility_epoch/);
  assert.match(pruneContinuation, /visibilityEpoch = activeVisibilityEpoch\(\s*pruned/);
  const gateway = section('async function gatewayMetadataPage', '\nasync function gatewayRequestJson');
  assert.match(gateway, /assertProviderReadAllowed/);
  const rpc = section('async function workerRpc', '\nasync function settleJob');
  assert.match(rpc, /error\?\.code === "40001"/);
  assert.match(rpc, /new WorkerFault\("stale", true\)/);
  const workerFailure = section('    } catch (error) {', '\n  }\n  return successResponse');
  assert.match(workerFailure, /failure\.queueCode !== "stale"/);
});

test('identity validation is bounded, complete and persists only comparator metrics', () => {
  const validation = section('async function validateCredentialCandidateJob', '\nasync function failCredentialValidation');
  assert.match(validation, /gatewayAccountInfo/);
  assert.match(validation, /norva_mark_credential_candidate_validated/);
  assert.doesNotMatch(validation, /get_live_streams|get_vod_streams|get_series/);
  const assessment = section('async function assessSealedCredentialGeneration', '\nfunction normalizeCatalogIdentityEvidence');
  assert.match(assessment, /compareProviderCatalogIdentity/);
  assert.match(assessment, /norva_record_credential_identity_assessment/);
  assert.match(assessment, /p_sample_size_old/);
  assert.match(assessment, /p_overlap_count/);
  assert.match(assessment, /Number\(assessment\.similarityScore\.toFixed\(5\)\)/);
  assert.match(assessment, /generation\.strongIdentity\.distinct/);
  assert.match(assessment, /content_manifest_checksum_match: assessment\.contentManifest\.matching/);
  assert.match(assessment, /manifest_and_typed_overlap_same_catalog/);
  assert.match(assessment, /manifest_mismatch/);
  assert.doesNotMatch(assessment, /p_.*(?:username|password|server_url|external_ids|raw)/i);
  const evidence = section('function normalizeCatalogIdentityEvidence', '\nfunction boundedIdentityCategories');
  assert.match(evidence, /contentManifestChecksum/);
  assert.match(evidence, /\^\[a-f0-9\]\{64\}\$/);
  assert.match(evidence, /host: new URL\(config\.serverUrl\)\.host/);
  assert.doesNotMatch(evidence, /\{32,64\}/);
});

test('terminal candidate rejection is finalized by SQL and is not settled twice', async () => {
  const source = section('async function validateCredentialCandidateJob', '\nasync function failCredentialValidation');
  class WorkerFault extends Error {
    constructor(queueCode, retryable, publicCode = 'PROVIDER_CHECK_TEMPORARY_FAILURE') {
      super(publicCode); this.queueCode = queueCode; this.retryable = retryable;
    }
  }
  const failures = [];
  const validate = vm.runInNewContext(`(() => { ${source}; return validateCredentialCandidateJob; })()`, {
    WorkerFault,
    getRuntimeConfig: async () => ({
      sourceConfigKey: 'key', mediaGatewayUrl: 'https://gateway.example', mediaGatewayToken: 'token',
    }),
    readTransitionSecret: async () => 'ciphertext',
    decryptSourceConfig: async () => ({ serverUrl: 'https://provider.invalid', username: 'u', password: 'p' }),
    assertProviderReadAllowed: async () => {},
    gatewayAccountInfo: async () => ({ user_info: { auth: 0 } }),
    assertAuthenticatedAccount() { throw new WorkerFault('auth_rejected', false); },
    normalizeWorkerFault: (error) => error,
    failCredentialValidation: async (_job, code) => { failures.push(code); },
    workerRpc: async () => { throw new Error('must not validate after rejection'); },
  });
  const disposition = await validate({ transitionId: 't' }, 'worker');
  assert.equal(disposition, 'handled');
  assert.deepEqual(failures, ['candidate_auth_rejected']);
});

test('distributed/local account busy retries validation without gateway fetch or transition mutation', async () => {
  const source = section('async function validateCredentialCandidateJob', '\nasync function failCredentialValidation');
  class WorkerFault extends Error {
    constructor(queueCode, retryable) { super(queueCode); this.queueCode = queueCode; this.retryable = retryable; }
  }
  let gatewayCalls = 0;
  let mutationCalls = 0;
  const validate = vm.runInNewContext(`(() => { ${source}; return validateCredentialCandidateJob; })()`, {
    WorkerFault,
    getRuntimeConfig: async () => ({
      sourceConfigKey: 'key', mediaGatewayUrl: 'https://gateway.example', mediaGatewayToken: 'token',
    }),
    readTransitionSecret: async () => 'ciphertext',
    decryptSourceConfig: async () => ({ serverUrl: 'https://provider.invalid', username: 'u', password: 'p' }),
    assertProviderReadAllowed: async () => { throw new WorkerFault('rate_limited', true); },
    gatewayAccountInfo: async () => { gatewayCalls += 1; return {}; },
    assertAuthenticatedAccount: () => {},
    normalizeWorkerFault: (error) => error,
    failCredentialValidation: async () => { mutationCalls += 1; },
    workerRpc: async () => { mutationCalls += 1; },
  });
  await assert.rejects(
    validate({ transitionId: 't' }, 'worker'),
    (error) => error.queueCode === 'rate_limited' && error.retryable === true,
  );
  assert.equal(gatewayCalls, 0);
  assert.equal(mutationCalls, 0);
  const accountKeySource = section('function providerAccountActivityKey', '\nasync function gatewayMetadataPage');
  const accountAffinity = vm.runInNewContext(`(() => {
    ${accountKeySource}
    return { providerAccountActivityKey, credentialAccountAffinityHash };
  })()`, {
    URL,
    String,
    WorkerFault,
    Error,
    Uint8Array,
    TextEncoder,
    bytesToHex: (bytes) => Buffer.from(bytes).toString('hex'),
    crypto: nodeCrypto.webcrypto,
  });
  const config = {
    serverUrl: 'https://Panel.Example:8443/base', username: '  account-user  ',
  };
  const canonicalKey = accountAffinity.providerAccountActivityKey(config);
  assert.equal(canonicalKey, 'panel.example:8443/  account-user  ');
  assert.equal(
    await accountAffinity.credentialAccountAffinityHash(config),
    nodeCrypto.createHash('sha256').update(canonicalKey).digest('hex'),
  );
  const postSwitch = section('async function verifyPostSwitchJob', '\nasync function restoreAfterPostSwitchFailure');
  assert.ok(postSwitch.indexOf('if (fault.retryable) throw fault') < postSwitch.indexOf('restoreAfterPostSwitchFailure'));
  const restore = section('async function restoreAfterPostSwitchFailure', '\nasync function verifyRollbackJob');
  assert.match(restore, /norva_restore_previous_credential_config/);
});

test('retry exhaustion finalizes pre-commit validation or starts compensation without double-settling the lease', async () => {
  const source = section('async function handleWorkerDrain', '\nasync function requireWorkerAuthorization');
  class WorkerFault extends Error {
    constructor(queueCode, retryable) { super(queueCode); this.queueCode = queueCode; this.retryable = retryable; }
  }
  async function run(kind) {
    const calls = { failed: 0, restored: 0, settled: 0 };
    const handleWorkerDrain = vm.runInNewContext(`(() => { ${source}; return handleWorkerDrain; })()`, {
      WORKER_MAX_CLAIMS: 1,
      WORKER_LEASE_SECONDS: 300,
      WORKER_PROTOCOL: 'credential-transition-worker-v3-active-catalog-refresh',
      ACTIVE_CATALOG_REFRESH_CONTRACT_ID: 'active-catalog-refresh-checkpoint-prune-v1',
      crypto: { randomUUID: () => 'worker-id' },
      requireWorkerAuthorization: async () => {},
      readJsonObject: async () => ({}),
      credentialFeatureFlagEnabled: async () => true,
      replacementFeatureFlagEnabled: async () => false,
      admin: { rpc: async (name) => name === 'norva_register_active_catalog_refresh_worker'
        ? { data: {
          ready: true,
          workerProtocol: 'credential-transition-worker-v3-active-catalog-refresh',
          refreshContractId: 'active-catalog-refresh-checkpoint-prune-v1',
        }, error: null }
        : { data: [{ job_kind: kind }], error: null } },
      normalizeClaimedJob: () => ({ kind, failureAttemptCount: 4 }),
      processWorkerJobUnderGuards: async () => { throw new WorkerFault('provider_unavailable', true); },
      normalizeWorkerFault: (error) => error,
      failCredentialValidation: async () => { calls.failed += 1; },
      restoreAfterPostSwitchFailure: async () => { calls.restored += 1; },
      settleJob: async () => { calls.settled += 1; return true; },
      workerRetryAttemptLimit: () => 4,
      retryDelaySeconds: () => 30,
      successResponse: (_req, _requestId, _kind, summary) => summary,
      console: { warn() {} },
      WorkerFault,
      Array,
      Number,
      Math,
      String,
      isRecord: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
    });
    const summary = await handleWorkerDrain({}, 'request');
    return { calls, summary };
  }
  for (const kind of ['validate_candidate', 'build_candidate_generation']) {
    const result = await run(kind);
    assert.deepEqual(result.calls, { failed: 1, restored: 0, settled: 0 });
    assert.equal(result.summary.completed, 1);
  }
  const post = await run('post_switch_verify');
  assert.deepEqual(post.calls, { failed: 0, restored: 1, settled: 0 });
  assert.equal(post.summary.completed, 1);
});

test('worker uses durable bounded lease/claim/settle CAS and waitUntil is only an accelerator', () => {
  const worker = section('async function handleWorkerDrain', '\nasync function requireWorkerAuthorization');
  assert.match(worker, /norva_claim_credential_transition_jobs/);
  assert.match(worker, /WORKER_MAX_CLAIMS/);
  assert.match(EDGE, /const WORKER_MAX_CLAIMS = 1/);
  assert.match(worker, /p_lease_seconds/);
  assert.match(worker, /p_worker_protocol: WORKER_PROTOCOL/);
  assert.match(EDGE, /const WORKER_PROTOCOL = "credential-transition-worker-v3-active-catalog-refresh"/);
  assert.match(worker, /registerActiveCatalogRefreshWorker\(workerId\)/);
  assert.match(worker, /norva_register_active_catalog_refresh_worker/);
  assert.match(TRANSITION_MIGRATION, /credential-transition-worker-v2-title-cleanup/);
  assert.match(worker, /settleJob/);
  assert.match(EDGE, /norva_settle_credential_transition_job/);
  assert.match(EDGE, /p_expected_attempt: job\.leaseSequence/);
  for (const kind of [
    'validate_candidate', 'build_candidate_generation', 'post_switch_verify', 'rollback_refresh',
    'promote_generation_titles', 'purge_terminal_generation',
  ]) {
    assert.ok(EDGE.includes(`"${kind}"`));
  }
  assert.match(EDGE, /norva_checkpoint_credential_generation_job/);
  assert.match(EDGE_DEPLOY, /norva-provider-access\/index\.ts/);
  assert.match(EDGE_DEPLOY, /norva-provider-access source digest mismatch/);
  assert.match(EDGE_DEPLOY, /_shared\/live-materialization\.ts/);
  assert.match(EDGE_DEPLOY, /shared live-materialization source digest mismatch/);
  assert.match(EDGE, /p_retry_after_seconds: staged\.pending === true/);
  assert.match(EDGE, /maxSlices: 8/);
  assert.match(EDGE, /deadlineMs: 45_000/);
  const accelerator = section('function scheduleWorkerAcceleration', '\nasync function readJsonObject');
  assert.match(accelerator, /waitUntil\(Promise\.resolve\(\)\)/);
  assert.doesNotMatch(accelerator, /processClaimedJob|handleWorkerDrain|fetch/);
});

test('worker claim protocol is rolling-safe in both DB-first and Edge-first orders', async () => {
  const claimSource = section(
    'async function claimCredentialTransitionJobs',
    '\nasync function requireWorkerAuthorization',
  );
  const calls = [];
  let mode = 'db-new';
  const claimCredentialTransitionJobs = vm.runInNewContext(`(() => {
    ${claimSource}
    return claimCredentialTransitionJobs;
  })()`, {
    WORKER_LEASE_SECONDS: 300,
    WORKER_PROTOCOL: 'credential-transition-worker-v3-active-catalog-refresh',
    admin: {
      rpc: async (name, params) => {
        calls.push({ name, params: structuredClone(params) });
        if (mode === 'db-old' && calls.length === 1) {
          return { data: null, error: {
            code: 'PGRST202',
            message: 'Could not find the function public.norva_claim_credential_transition_jobs(p_lease_seconds, p_limit, p_worker, p_worker_protocol) in the schema cache',
          } };
        }
        if (mode === 'nested-missing') return { data: null, error: {
          code: '42883',
          message: 'function public.some_nested_dependency(uuid) does not exist',
          details: 'while executing norva_claim_credential_transition_jobs',
        } };
        if (mode === 'db-error') return { data: null, error: { code: '55P03' } };
        return {
          data: [{ job_kind: params.p_worker_protocol ? 'promote_generation_titles' : 'post_switch_verify' }],
          error: null,
        };
      },
    },
    isRecord: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
    String,
  });

  let result = await claimCredentialTransitionJobs('worker', 1);
  assert.equal(result.error, null);
  assert.equal(result.data[0].job_kind, 'promote_generation_titles');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.p_worker_protocol, 'credential-transition-worker-v3-active-catalog-refresh');

  mode = 'db-old';
  calls.length = 0;
  result = await claimCredentialTransitionJobs('worker', 1);
  assert.equal(result.error, null);
  assert.equal(result.data[0].job_kind, 'post_switch_verify');
  assert.equal(calls.length, 2);
  assert.equal(Object.hasOwn(calls[1].params, 'p_worker_protocol'), false);

  mode = 'db-error';
  calls.length = 0;
  result = await claimCredentialTransitionJobs('worker', 1);
  assert.equal(result.error.code, '55P03');
  assert.equal(calls.length, 1);

  mode = 'nested-missing';
  calls.length = 0;
  result = await claimCredentialTransitionJobs('worker', 1);
  assert.equal(result.error.code, '42883');
  assert.equal(calls.length, 1);

  assert.match(TRANSITION_MIGRATION, /credential-transition-worker-v2-title-cleanup/);
  assert.match(TRANSITION_MIGRATION, /job\.job_kind = 'post_switch_verify'[\s\S]{0,160}?credential-transition-worker-v3-active-catalog-refresh/);
  assert.match(TRANSITION_MIGRATION, /p_worker, p_limit, p_lease_seconds, null::text/);
});

test('worker starts one job only with sufficient lease and keeps recovery claimable when the feature is off', async () => {
  const guards = section('function workerJobAllowedByFeatureFlag', '\nasync function processClaimedJob');
  class WorkerFault extends Error {
    constructor(queueCode, retryable) { super(queueCode); this.queueCode = queueCode; this.retryable = retryable; }
  }
  const calls = [];
  const processWorkerJobUnderGuards = vm.runInNewContext(`(() => {
    ${guards}
    return processWorkerJobUnderGuards;
  })()`, {
    WorkerFault,
    WORKER_MIN_START_LEASE_MS: 150_000,
    Date,
    Number,
    processClaimedJob: async (job) => { calls.push(job.kind); return 'settle'; },
  });
  const futureLease = 1_000_000;
  assert.equal(await processWorkerJobUnderGuards(
    { kind: 'validate_candidate', leaseUntilMs: futureLease }, 'worker', false, 0,
  ), 'feature_blocked');
  assert.deepEqual(calls, []);
  assert.equal(await processWorkerJobUnderGuards(
    { kind: 'post_switch_verify', leaseUntilMs: futureLease }, 'worker', false, 0,
  ), 'settle');
  assert.deepEqual(calls, ['post_switch_verify']);
  await assert.rejects(
    processWorkerJobUnderGuards(
      { kind: 'build_candidate_generation', leaseUntilMs: futureLease }, 'worker', true, 900_000,
    ),
    (error) => error.queueCode === 'lease_expired' && error.retryable === true,
  );
  assert.deepEqual(calls, ['post_switch_verify']);
  const worker = section('async function handleWorkerDrain', '\nasync function requireWorkerAuthorization');
  assert.ok(worker.indexOf('credentialFeatureFlagEnabled()') < worker.indexOf('processWorkerJobUnderGuards'));
  assert.match(worker, /featureBlocked/);
});

test('terminal title promotion and failed-or-cancelled generation purge use one bounded durable batch per lease', async () => {
  const handlers = section(
    'const TERMINAL_CONTINUATION_BATCH_LIMIT',
    '\nasync function validateCredentialCandidateJob',
  );
  class WorkerFault extends Error {
    constructor(queueCode, retryable) { super(queueCode); this.queueCode = queueCode; this.retryable = retryable; }
  }
  const calls = [];
  const generationId = '11111111-1111-4111-8111-111111111111';
  const job = {
    jobId: '22222222-2222-4222-8222-222222222222',
    userId: '33333333-3333-4333-8333-333333333333',
    catalogGenerationId: generationId,
    leaseSequence: 7,
  };
  let promotionComplete = false;
  let purgeComplete = false;
  const runtime = vm.runInNewContext(`(() => {
    ${handlers}
    return { promoteGenerationTitlesJob, purgeTerminalGenerationJob };
  })()`, {
    admin: {
      rpc: async (name, params) => {
        calls.push({ name, params: structuredClone(params) });
        if (name === 'norva_promote_credential_generation_titles_batch') {
          return { data: {
            generationId, processedTitles: promotionComplete ? 3 : 200,
            limit: 200, complete: promotionComplete,
          }, error: null };
        }
        if (name === 'norva_purge_cancelled_credential_generation_batch') {
          return { data: {
            generationId, deletedRows: purgeComplete ? 4 : 200,
            complete: purgeComplete,
          }, error: null };
        }
        return { data: { state: 'PENDING' }, error: null };
      },
    },
    generationId,
    WorkerFault,
    isRecord: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
    uuidValue: (value) => String(value),
    nonNegativeInteger: (value) => {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < 0) throw new Error('integer');
      return number;
    },
    Array,
    Number,
    String,
  });

  assert.equal(await runtime.promoteGenerationTitlesJob(job, 'worker'), 'checkpointed');
  assert.deepEqual(calls.map((call) => call.name), [
    'norva_promote_credential_generation_titles_batch',
    'norva_requeue_credential_title_promotion',
  ]);
  assert.equal(calls[0].params.p_limit, 200);
  assert.equal(calls[1].params.p_expected_lease_sequence, 7);
  promotionComplete = true;
  calls.length = 0;
  assert.equal(await runtime.promoteGenerationTitlesJob(job, 'worker'), 'settle');
  assert.deepEqual(calls.map((call) => call.name), ['norva_promote_credential_generation_titles_batch']);

  calls.length = 0;
  assert.equal(await runtime.purgeTerminalGenerationJob(job, 'worker'), 'checkpointed');
  assert.deepEqual(calls.map((call) => call.name), [
    'norva_purge_cancelled_credential_generation_batch',
    'norva_requeue_credential_generation_purge',
  ]);
  assert.equal(calls[0].params.p_limit, 200);
  purgeComplete = true;
  calls.length = 0;
  assert.equal(await runtime.purgeTerminalGenerationJob(job, 'worker'), 'settle');
  assert.deepEqual(calls.map((call) => call.name), ['norva_purge_cancelled_credential_generation_batch']);
});

test('one malformed claimed row is dead-settled without aborting the rest of the drain', async () => {
  const source = section('async function handleWorkerDrain', '\nasync function requireWorkerAuthorization');
  const settlements = [];
  const handleWorkerDrain = vm.runInNewContext(`(() => { ${source}; return handleWorkerDrain; })()`, {
    WORKER_MAX_CLAIMS: 2,
    WORKER_LEASE_SECONDS: 300,
    WORKER_PROTOCOL: 'credential-transition-worker-v3-active-catalog-refresh',
    ACTIVE_CATALOG_REFRESH_CONTRACT_ID: 'active-catalog-refresh-checkpoint-prune-v1',
    crypto: { randomUUID: () => 'worker-id' },
    requireWorkerAuthorization: async () => {},
    readJsonObject: async () => ({ limit: 2 }),
    credentialFeatureFlagEnabled: async () => false,
    replacementFeatureFlagEnabled: async () => false,
    admin: { rpc: async (name) => name === 'norva_register_active_catalog_refresh_worker'
      ? { data: {
        ready: true,
        workerProtocol: 'credential-transition-worker-v3-active-catalog-refresh',
        refreshContractId: 'active-catalog-refresh-checkpoint-prune-v1',
      }, error: null }
      : { data: [{ malformed: true }, { malformed: false }], error: null } },
    normalizeClaimedJob: (raw) => {
      if (raw.malformed) throw new Error('schema drift');
      return { kind: 'promote_generation_titles', failureAttemptCount: 0 };
    },
    claimedJobLeaseIdentity: () => ({ jobId: 'claim-id', leaseSequence: 4 }),
    processWorkerJobUnderGuards: async () => 'settle',
    normalizeWorkerFault: (error) => error,
    settleJob: async (_job, _worker, outcome, code) => {
      settlements.push({ outcome, code });
      return true;
    },
    failCredentialValidation: async () => {},
    restoreAfterPostSwitchFailure: async () => {},
    workerRetryAttemptLimit: () => 4,
    retryDelaySeconds: () => 30,
    successResponse: (_req, _requestId, _kind, summary) => summary,
    console: { warn() {} },
    Array,
    Number,
    Math,
    String,
    isRecord: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  });
  const summary = await handleWorkerDrain({}, 'request');
  assert.deepEqual(settlements, [
    { outcome: 'dead', code: 'invalid_payload' },
    { outcome: 'completed', code: null },
  ]);
  assert.equal(summary.dead, 1);
  assert.equal(summary.completed, 1);
  assert.equal(summary.leaseLost, 0);
});

test('worker verifies the shared bearer plus an independent fixed token in-function', () => {
  const auth = section('async function requireWorkerAuthorization', '\nfunction normalizeClaimedJob');
  assert.match(auth, /Authorization/);
  assert.match(auth, /X-Norva-Worker-Token/);
  assert.match(auth, /WORKER_TOKEN/);
  assert.match(auth, /constantTimeEqual/);
  assert.match(auth, /norva_verify_cron_secret/);
  assert.match(auth, /AUTHENTICATION_REQUIRED/);
  assert.match(SUPABASE_CONFIG, /\[functions\.norva-provider-access\]\nverify_jwt = false/);
});

test('generation build is durable and only a sealed READY continuation can be assessed', () => {
  const seal = section('const MANIFEST_SEAL_BATCH_LIMIT', '\nasync function buildCandidateGenerationJob');
  const build = section('async function buildCandidateGenerationJob', '\nasync function readTransitionSecret');
  assert.match(build, /stageXtreamCredentialCatalogGeneration/);
  assert.match(build, /norva_allocate_credential_catalog_generation/);
  assert.match(build, /norva_checkpoint_credential_generation_job/);
  assert.match(build, /sealCredentialCatalogGenerationUnderLease/);
  assert.match(seal, /norva_seal_credential_catalog_generation/);
  assert.match(seal, /MANIFEST_SEAL_MAX_SLICES = 32/);
  assert.match(seal, /MANIFEST_SEAL_DEADLINE_MS = 45_000/);
  assert.match(seal, /p_expected_generation_revision: expectedGenerationRevision/);
  assert.match(seal, /p_expected_checkpoint_revision: expectedCheckpointRevision/);
  assert.match(build, /return "checkpointed"/);
  assert.match(build, /generation\.state !== "READY"/);
  assert.match(build, /assessSealedCredentialGeneration/);
  assert.match(build, /catalog_changed_during_build/);
  assert.match(build, /failCredentialValidation\(job, "catalog_changed_during_staging"\)/);
  assert.doesNotMatch(EDGE, /fetchCompleteGatewayInventory|norva_promote_isolated_credential_catalog_generation/);
  assert.doesNotMatch(EDGE, /\.from\("cloud_(?:media_items|title_variants|live_logical_channels|live_variants)"\)\.(?:insert|upsert|update|delete)/);
  assert.doesNotMatch(EDGE, /driveXtreamSyncToReady/);
  assert.match(EDGE, /norva_restore_previous_credential_config/);
  assert.match(EDGE, /norva_finish_credential_compensation/);
});

test('manifest seal chains revisions under one lease and checkpoints exactly once at each bound', async () => {
  const source = section(
    'const MANIFEST_SEAL_BATCH_LIMIT',
    '\nasync function buildCandidateGenerationJob',
  );
  class WorkerFault extends Error {
    constructor(queueCode, retryable) {
      super(queueCode);
      this.queueCode = queueCode;
      this.retryable = retryable;
    }
  }
  let rpcImpl = async () => { throw new Error('rpc not configured'); };
  const runtime = vm.runInNewContext(`(() => {
    ${source}
    return { sealCredentialCatalogGenerationUnderLease };
  })()`, {
    WORKER_MIN_START_LEASE_MS: 150_000,
    WorkerFault,
    workerRpc: (...args) => rpcImpl(...args),
    isRecord: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
    uuidValue: (value) => String(value),
    nonNegativeInteger: (value) => {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < 0) throw new WorkerFault('invalid_payload', false);
      return number;
    },
    canonicalJson: (value) => JSON.stringify(value, Object.keys(value ?? {}).sort()),
    Array,
    Date,
    Number,
    String,
  });

  const transitionId = '11111111-1111-4111-8111-111111111111';
  const generationId = '22222222-2222-4222-8222-222222222222';
  const job = {
    jobId: '33333333-3333-4333-8333-333333333333',
    userId: '44444444-4444-4444-8444-444444444444',
    transitionId,
    leaseSequence: 7,
    checkpointRevision: 4,
    leaseUntilMs: 1_000_000,
    progress: { action: 'complete', categoriesDone: true },
  };
  const incomplete = (revision, phase = 'media_items', overrides = {}) => ({
    transitionId,
    generationId,
    generationState: 'BUILDING',
    generationRevision: revision,
    sealRole: 'previous',
    sealPhase: phase,
    processedRows: 25_000,
    batchLimit: 25_000,
    complete: false,
    leaseRetained: true,
    checkpointRevision: 4,
    ...overrides,
  });
  const complete = (revision) => ({
    transitionId,
    generationId,
    generationState: 'READY',
    generationRevision: revision,
    sealRole: null,
    sealPhase: 'complete',
    processedRows: 17,
    batchLimit: 25_000,
    complete: true,
    leaseRetained: false,
  });

  const revisionCalls = [];
  const revisionResponses = [
    incomplete(11),
    incomplete(11, 'title_variants'),
    complete(12),
  ];
  rpcImpl = async (name, params) => {
    revisionCalls.push({ name, params: structuredClone(params) });
    assert.equal(name, 'norva_seal_credential_catalog_generation');
    return revisionResponses.shift();
  };
  assert.deepEqual(
    structuredClone(await runtime.sealCredentialCatalogGenerationUnderLease({
      job, workerId: 'worker', generationId, transitionRevision: 8,
      generationRevision: 10, now: () => 0,
    })),
    { complete: true, slices: 3 },
  );
  assert.deepEqual(
    revisionCalls.map((call) => call.params.p_expected_generation_revision),
    [10, 11, 11],
  );
  assert.equal(revisionCalls.filter((call) => call.name.includes('checkpoint')).length, 0);

  const quotaCalls = [];
  rpcImpl = async (name, params) => {
    quotaCalls.push({ name, params: structuredClone(params) });
    if (name === 'norva_seal_credential_catalog_generation') return incomplete(11);
    return {
      jobId: job.jobId,
      state: 'PENDING',
      checkpointRevision: 5,
      progress: structuredClone(job.progress),
    };
  };
  assert.deepEqual(
    structuredClone(await runtime.sealCredentialCatalogGenerationUnderLease({
      job, workerId: 'worker', generationId, transitionRevision: 8,
      generationRevision: 10, now: () => 0,
    })),
    { complete: false, slices: 32 },
  );
  assert.equal(quotaCalls.filter((call) => call.name === 'norva_seal_credential_catalog_generation').length, 32);
  assert.equal(quotaCalls.filter((call) => call.name === 'norva_checkpoint_credential_generation_job').length, 1);
  assert.equal(quotaCalls.at(-1).params.p_expected_checkpoint_revision, 4);
  assert.deepEqual(quotaCalls.at(-1).params.p_progress, job.progress);

  for (const bound of ['deadline', 'lease']) {
    const boundedCalls = [];
    rpcImpl = async (name, params) => {
      boundedCalls.push({ name, params: structuredClone(params) });
      if (name === 'norva_seal_credential_catalog_generation') return incomplete(11);
      return {
        jobId: job.jobId,
        state: 'PENDING',
        checkpointRevision: 5,
        progress: structuredClone(job.progress),
      };
    };
    const ticks = bound === 'deadline' ? [0, 0, 46_000] : [0, 0, 1_000];
    const boundedJob = bound === 'lease' ? { ...job, leaseUntilMs: 150_000 } : job;
    assert.deepEqual(
      structuredClone(await runtime.sealCredentialCatalogGenerationUnderLease({
        job: boundedJob, workerId: 'worker', generationId, transitionRevision: 8,
        generationRevision: 10, now: () => ticks.shift() ?? ticks.at(-1) ?? 46_000,
      })),
      { complete: false, slices: 1 },
    );
    assert.deepEqual(boundedCalls.map((call) => call.name), [
      'norva_seal_credential_catalog_generation',
      'norva_checkpoint_credential_generation_job',
    ]);
  }

  rpcImpl = async () => incomplete(11, 'media_items', { leaseRetained: false });
  await assert.rejects(
    runtime.sealCredentialCatalogGenerationUnderLease({
      job, workerId: 'worker', generationId, transitionRevision: 8,
      generationRevision: 10, now: () => 0,
    }),
    (error) => error.queueCode === 'invalid_payload' && error.retryable === false,
  );
});

test('different catalogs cannot reach apply and ambiguous candidates require an explicit decision', () => {
  const apply = section('async function applyCredentialCandidate', '\nasync function cancelCredentialCandidate');
  assert.match(apply, /snapshot\.comparison === "DIFFERENT_CATALOG"/);
  assert.match(apply, /DIFFERENT_CATALOG_REQUIRES_REPLACEMENT/);
  assert.match(apply, /snapshot\.comparison !== "SAME_CATALOG"/);
  const decision = section('async function decideCredentialCandidate', '\nasync function applyCredentialCandidate');
  assert.match(decision, /KEEP_AS_SAME_CATALOG/);
  assert.match(decision, /REPLACE_WITH_NEW_CATALOG/);
  assert.match(decision, /norva_decide_ambiguous_credential_transition/);
});
