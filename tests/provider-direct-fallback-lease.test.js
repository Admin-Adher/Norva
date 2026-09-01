'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { transformSync } = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_ID = '10000000-0000-4000-8000-000000000001';
const USER_ID = '20000000-0000-4000-8000-000000000002';
const LEASE_TOKEN = '30000000-0000-4000-8000-000000000003';
const OWNER = 'edge-test-40000000-0000-4000-8000-000000000004';
const SNAPSHOT_PROOF = Object.freeze({
  expectedProviderAccountAffinityHash: 'a'.repeat(64),
  expectedConfigRevision: '7',
  expectedConfigCiphertextHash: 'b'.repeat(64),
});
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n?/g, '\n');

async function leaseModule() {
  return import(pathToFileURL(path.join(
    ROOT,
    'supabase/functions/_shared/provider-direct-fallback-lease.mjs',
  )).href);
}

async function boundedProviderModule() {
  return import(pathToFileURL(path.join(
    ROOT,
    'supabase/functions/_shared/bounded-provider-response.mjs',
  )).href);
}

function successfulClaim() {
  return {
    claimed: true,
    sourceId: SOURCE_ID,
    userId: USER_ID,
    leaseToken: LEASE_TOKEN,
    leaseOwner: OWNER,
    leaseUntil: new Date(Date.now() + 60_000).toISOString(),
  };
}

function fakeDb(responses, calls) {
  return {
    async rpc(name, args) {
      calls.push({ name, args });
      const next = responses.shift();
      assert.ok(next, `unexpected RPC ${name}`);
      return typeof next === 'function' ? next(name, args) : next;
    },
  };
}

test('active transition rejects the atomic claim before any direct provider operation', async () => {
  const {
    PROVIDER_DIRECT_FALLBACK_CLAIM_RPC,
    PROVIDER_DIRECT_FALLBACK_ERROR_CODE,
    ProviderDirectFallbackLeaseError,
    withSourceDirectFallbackLease,
  } = await leaseModule();
  const calls = [];
  let providerFetches = 0;
  const db = fakeDb([{
    data: null,
    error: {
      code: '55P03',
      message: 'source direct fallback blocked by active transition',
      details: 'reason=transition_active',
    },
  }], calls);

  await assert.rejects(
    withSourceDirectFallbackLease({
      db,
      sourceId: SOURCE_ID,
      userId: USER_ID,
      owner: OWNER,
      ttlSeconds: 30,
      ...SNAPSHOT_PROOF,
    }, async () => {
      providerFetches++;
    }),
    (error) => {
      assert.ok(error instanceof ProviderDirectFallbackLeaseError);
      assert.equal(error.status, 503);
      assert.equal(error.code, PROVIDER_DIRECT_FALLBACK_ERROR_CODE);
      assert.equal(error.reason, 'transition_active');
      assert.equal(error.retryable, true);
      return true;
    },
  );
  assert.equal(providerFetches, 0);
  assert.deepEqual(calls, [{
    name: PROVIDER_DIRECT_FALLBACK_CLAIM_RPC,
    args: {
      p_source_id: SOURCE_ID,
      p_user_id: USER_ID,
      p_owner: OWNER,
      p_ttl_seconds: 30,
      p_expected_provider_account_affinity_hash: SNAPSHOT_PROOF.expectedProviderAccountAffinityHash,
      p_expected_config_revision: SNAPSHOT_PROOF.expectedConfigRevision,
      p_expected_config_ciphertext_hash: SNAPSHOT_PROOF.expectedConfigCiphertextHash,
    },
  }]);
  assert.equal(JSON.stringify(calls).includes('username'), false);
  assert.equal(JSON.stringify(calls).includes('password'), false);
  assert.equal(JSON.stringify(calls).includes('provider.example'), false);
});

test('DB-old without the seven-argument claim overload fails closed with zero provider fetches', async () => {
  const {
    PROVIDER_DIRECT_FALLBACK_CLAIM_RPC,
    ProviderDirectFallbackLeaseError,
    withSourceDirectFallbackLease,
  } = await leaseModule();

  for (const code of ['42883', 'PGRST202']) {
    const calls = [];
    let providerFetches = 0;
    const db = fakeDb([{
      data: null,
      error: { code, message: 'function overload was not found' },
    }], calls);

    await assert.rejects(
      withSourceDirectFallbackLease({
        db,
        sourceId: SOURCE_ID,
        userId: USER_ID,
        owner: OWNER,
        ttlSeconds: 30,
        ...SNAPSHOT_PROOF,
      }, async () => { providerFetches++; }),
      (error) => error instanceof ProviderDirectFallbackLeaseError &&
        error.status === 503 && error.reason === 'claim_failed',
      code,
    );
    assert.equal(providerFetches, 0, code);
    assert.equal(calls.length, 1, code);
    assert.equal(calls[0].name, PROVIDER_DIRECT_FALLBACK_CLAIM_RPC, code);
    assert.deepEqual(Object.keys(calls[0].args).sort(), [
      'p_expected_config_ciphertext_hash',
      'p_expected_config_revision',
      'p_expected_provider_account_affinity_hash',
      'p_owner',
      'p_source_id',
      'p_ttl_seconds',
      'p_user_id',
    ]);
  }
});

test('snapshot proof is canonical, opaque, and never contains credentials or ciphertext', async () => {
  const { buildProviderDirectFallbackSnapshot } = await leaseModule();
  const proof = await buildProviderDirectFallbackSnapshot({
    serverUrl: 'https://Panel.Example:8443/base?ignored=1',
    username: '  private-user  ',
    password: 'not-consumed',
    configCiphertext: 'aesgcm.v1.iv.encrypted-private-config',
    configRevision: '0007',
  });
  assert.match(proof.expectedProviderAccountAffinityHash, /^[0-9a-f]{64}$/);
  assert.equal(
    proof.expectedProviderAccountAffinityHash,
    nodeCrypto.createHash('sha256').update('panel.example:8443/  private-user  ', 'utf8').digest('hex'),
  );
  assert.match(proof.expectedConfigCiphertextHash, /^[0-9a-f]{64}$/);
  assert.equal(proof.expectedConfigRevision, '7');
  const serialized = JSON.stringify(proof);
  for (const forbidden of [
    'private-user', 'not-consumed', 'aesgcm.v1', 'panel.example', '/base', 'ignored',
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test('different-affinity and same-affinity password ABA both fail before provider fetch', async () => {
  const {
    buildProviderDirectFallbackSnapshot,
    ProviderDirectFallbackLeaseError,
    withSourceDirectFallbackLease,
  } = await leaseModule();
  const loadedA = await buildProviderDirectFallbackSnapshot({
    serverUrl: 'https://provider-a.example',
    username: 'same-user',
    configCiphertext: 'ciphertext-A',
    configRevision: '7',
  });
  const swaps = [
    await buildProviderDirectFallbackSnapshot({
      serverUrl: 'https://provider-b.example',
      username: 'other-user',
      configCiphertext: 'ciphertext-B',
      configRevision: '8',
    }),
    await buildProviderDirectFallbackSnapshot({
      serverUrl: 'https://provider-a.example',
      username: 'same-user',
      configCiphertext: 'ciphertext-password-B',
      configRevision: '8',
    }),
  ];

  for (const current of swaps) {
    const calls = [];
    let providerFetches = 0;
    const db = {
      async rpc(name, args) {
        calls.push({ name, args });
        assert.equal(name, 'norva_claim_source_direct_fallback_lease');
        const matches =
          args.p_expected_provider_account_affinity_hash === current.expectedProviderAccountAffinityHash &&
          args.p_expected_config_revision === current.expectedConfigRevision &&
          args.p_expected_config_ciphertext_hash === current.expectedConfigCiphertextHash;
        return matches
          ? { data: successfulClaim(), error: null }
          : { data: null, error: { code: '40001', details: 'reason=source_config_snapshot_changed' } };
      },
    };
    let caught;
    await assert.rejects(
      withSourceDirectFallbackLease({
        db,
        sourceId: SOURCE_ID,
        userId: USER_ID,
        owner: OWNER,
        ttlSeconds: 30,
        ...loadedA,
      }, async () => { providerFetches++; }),
      (error) => {
        caught = error;
        return error instanceof ProviderDirectFallbackLeaseError && error.status === 503;
      },
    );
    assert.equal(providerFetches, 0);
    assert.equal(calls.length, 1, 'no release exists when the fenced claim was refused');
    const publicFailure = JSON.stringify({
      message: caught.message,
      status: caught.status,
      details: caught.details,
    });
    for (const secretProof of Object.values(loadedA)) {
      assert.equal(publicFailure.includes(secretProof), false);
    }
    assert.equal(publicFailure.includes('source_config_snapshot_changed'), false);
  }
});

test('successful direct operation releases the exact token before returning', async () => {
  const {
    PROVIDER_DIRECT_FALLBACK_CLAIM_RPC,
    PROVIDER_DIRECT_FALLBACK_RELEASE_RPC,
    withSourceDirectFallbackLease,
  } = await leaseModule();
  const calls = [];
  const db = fakeDb([
    { data: successfulClaim(), error: null },
    { data: true, error: null },
  ], calls);
  const order = [];

  const result = await withSourceDirectFallbackLease({
    db,
    sourceId: SOURCE_ID,
    userId: USER_ID,
    owner: OWNER,
    ttlSeconds: 45,
    ...SNAPSHOT_PROOF,
  }, async () => {
    order.push('provider');
    return { ok: true };
  });
  order.push('returned');

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(order, ['provider', 'returned']);
  assert.equal(calls[0].name, PROVIDER_DIRECT_FALLBACK_CLAIM_RPC);
  assert.deepEqual(calls[1], {
    name: PROVIDER_DIRECT_FALLBACK_RELEASE_RPC,
    args: {
      p_source_id: SOURCE_ID,
      p_user_id: USER_ID,
      p_lease_token: LEASE_TOKEN,
    },
  });
});

test('provider failure still releases the lease and preserves the provider verdict', async () => {
  const { PROVIDER_DIRECT_FALLBACK_RELEASE_RPC, withSourceDirectFallbackLease } = await leaseModule();
  const calls = [];
  const db = fakeDb([
    { data: successfulClaim(), error: null },
    { data: true, error: null },
  ], calls);
  const providerError = new Error('sanitized provider failure');

  await assert.rejects(
    withSourceDirectFallbackLease({
      db,
      sourceId: SOURCE_ID,
      userId: USER_ID,
      owner: OWNER,
      ttlSeconds: 45,
      ...SNAPSHOT_PROOF,
    }, async () => { throw providerError; }),
    (error) => error === providerError,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1].name, PROVIDER_DIRECT_FALLBACK_RELEASE_RPC);
});

test('release failure after a successful provider read is typed retryable', async () => {
  const { ProviderDirectFallbackLeaseError, withSourceDirectFallbackLease } = await leaseModule();
  const calls = [];
  const db = fakeDb([
    { data: successfulClaim(), error: null },
    { data: null, error: { code: '08006', message: 'connection failure' } },
  ], calls);

  await assert.rejects(
    withSourceDirectFallbackLease({
      db,
      sourceId: SOURCE_ID,
      userId: USER_ID,
      owner: OWNER,
      ttlSeconds: 45,
      ...SNAPSHOT_PROOF,
    }, async () => 'provider-result'),
    (error) => {
      assert.ok(error instanceof ProviderDirectFallbackLeaseError);
      assert.equal(error.reason, 'release_failed');
      assert.equal(error.retryable, true);
      return true;
    },
  );
  assert.equal(calls.length, 2);
});

test('one run serializes concurrent direct legs without reducing gateway concurrency', async () => {
  const {
    PROVIDER_DIRECT_FALLBACK_CLAIM_RPC,
    PROVIDER_DIRECT_FALLBACK_RELEASE_RPC,
    createSourceDirectFallbackLeaseRunner,
  } = await leaseModule();
  const calls = [];
  const tokens = [
    '50000000-0000-4000-8000-000000000005',
    '60000000-0000-4000-8000-000000000006',
  ];
  let tokenIndex = 0;
  const db = {
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === PROVIDER_DIRECT_FALLBACK_CLAIM_RPC) {
        return {
          data: {
            claimed: true,
            sourceId: SOURCE_ID,
            userId: USER_ID,
            leaseToken: tokens[tokenIndex++],
            leaseOwner: args.p_owner,
            leaseUntil: new Date(Date.now() + 60_000).toISOString(),
          },
          error: null,
        };
      }
      assert.equal(name, PROVIDER_DIRECT_FALLBACK_RELEASE_RPC);
      return { data: true, error: null };
    },
  };
  const runDirectFallback = createSourceDirectFallbackLeaseRunner({
    db,
    sourceId: SOURCE_ID,
    userId: USER_ID,
    ownerScope: 'concurrent-test',
    ...SNAPSHOT_PROOF,
  });
  let active = 0;
  let maxActive = 0;
  const order = [];
  const operation = (id) => runDirectFallback(10_000, async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    order.push(`start-${id}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push(`end-${id}`);
    active--;
    return id;
  });

  assert.deepEqual(await Promise.all([operation(1), operation(2)]), [1, 2]);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2']);
  assert.deepEqual(calls.map((call) => call.name), [
    PROVIDER_DIRECT_FALLBACK_CLAIM_RPC,
    PROVIDER_DIRECT_FALLBACK_RELEASE_RPC,
    PROVIDER_DIRECT_FALLBACK_CLAIM_RPC,
    PROVIDER_DIRECT_FALLBACK_RELEASE_RPC,
  ]);
});

test('lease remains held from response headers through the complete bounded body parse', async () => {
  const { withSourceDirectFallbackLease } = await leaseModule();
  const { fetchBoundedProviderJson } = await boundedProviderModule();
  const originalFetch = global.fetch;
  const calls = [];
  let leaseHeld = false;
  let bodyController;
  const db = {
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === 'norva_claim_source_direct_fallback_lease') {
        leaseHeld = true;
        return { data: successfulClaim(), error: null };
      }
      assert.equal(name, 'norva_release_source_direct_fallback_lease');
      leaseHeld = false;
      return { data: true, error: null };
    },
  };
  global.fetch = async () => new Response(new ReadableStream({
    start(controller) { bodyController = controller; },
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  try {
    const pending = withSourceDirectFallbackLease({
      db,
      sourceId: SOURCE_ID,
      userId: USER_ID,
      owner: OWNER,
      ttlSeconds: 30,
      ...SNAPSHOT_PROOF,
    }, async () => {
      const result = await fetchBoundedProviderJson('https://provider.invalid/slow', {
        timeoutMs: 1_000,
        maxBytes: 1_024,
      });
      return result.value;
    });
    while (!bodyController) await new Promise((resolve) => setImmediate(resolve));

    assert.equal(leaseHeld, true, 'transition mutex must still be held after headers');
    assert.equal(calls.length, 1, 'release must wait for the body');
    const transitionAttempt = leaseHeld ? 'blocked' : 'incorrectly-allowed';
    assert.equal(transitionAttempt, 'blocked');

    bodyController.enqueue(new TextEncoder().encode('{"ready":true}'));
    bodyController.close();
    assert.deepEqual(await pending, { ready: true });
    assert.equal(leaseHeld, false);
    assert.deepEqual(calls.map((call) => call.name), [
      'norva_claim_source_direct_fallback_lease',
      'norva_release_source_direct_fallback_lease',
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('body deadline aborts the provider stream before the lease is released', async () => {
  const { withSourceDirectFallbackLease } = await leaseModule();
  const { BoundedProviderResponseError, fetchBoundedProviderJson } = await boundedProviderModule();
  const originalFetch = global.fetch;
  const order = [];
  const calls = [];
  const db = {
    async rpc(name) {
      calls.push(name);
      if (name === 'norva_claim_source_direct_fallback_lease') {
        return { data: successfulClaim(), error: null };
      }
      order.push('release');
      return { data: true, error: null };
    },
  };
  global.fetch = async (_url, options) => new Response(new ReadableStream({
    start(controller) {
      options.signal.addEventListener('abort', () => {
        order.push('abort');
        controller.error(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    },
  }), { status: 200 });

  try {
    await assert.rejects(
      withSourceDirectFallbackLease({
        db,
        sourceId: SOURCE_ID,
        userId: USER_ID,
        owner: OWNER,
        ttlSeconds: 30,
        ...SNAPSHOT_PROOF,
      }, () => fetchBoundedProviderJson('https://provider.invalid/stalled', {
        timeoutMs: 20,
        maxBytes: 1_024,
      })),
      (error) => error instanceof BoundedProviderResponseError && error.kind === 'timeout',
    );
    assert.deepEqual(order, ['abort', 'release']);
    assert.deepEqual(calls, [
      'norva_claim_source_direct_fallback_lease',
      'norva_release_source_direct_fallback_lease',
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('chunked provider bodies are cancelled at the byte cap before lease release', async () => {
  const { withSourceDirectFallbackLease } = await leaseModule();
  const { BoundedProviderResponseError, fetchBoundedProviderText } = await boundedProviderModule();
  const originalFetch = global.fetch;
  const order = [];
  const db = fakeDb([
    { data: successfulClaim(), error: null },
    () => { order.push('release'); return { data: true, error: null }; },
  ], []);
  global.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(6));
      controller.enqueue(new Uint8Array(6));
    },
    cancel() { order.push('cancel'); },
  }), { status: 200 });

  try {
    await assert.rejects(
      withSourceDirectFallbackLease({
        db,
        sourceId: SOURCE_ID,
        userId: USER_ID,
        owner: OWNER,
        ttlSeconds: 30,
        ...SNAPSHOT_PROOF,
      }, () => fetchBoundedProviderText('https://provider.invalid/oversize', {
        timeoutMs: 1_000,
        maxBytes: 10,
      })),
      (error) => error instanceof BoundedProviderResponseError && error.kind === 'too_large',
    );
    assert.deepEqual(order, ['cancel', 'release']);
  } finally {
    global.fetch = originalFetch;
  }
});

function extractFunction(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const paramsStart = source.indexOf('(', start);
  let paramsDepth = 0;
  let paramsEnd = -1;
  let paramsQuote = null;
  let paramsEscaped = false;
  for (let i = paramsStart; i < source.length; i++) {
    const ch = source[i];
    if (paramsQuote) {
      if (paramsEscaped) paramsEscaped = false;
      else if (ch === '\\') paramsEscaped = true;
      else if (ch === paramsQuote) paramsQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { paramsQuote = ch; continue; }
    if (ch === '(') paramsDepth++;
    if (ch === ')' && --paramsDepth === 0) { paramsEnd = i; break; }
  }
  assert.notEqual(paramsEnd, -1, `unterminated params for ${name}`);
  const bodyStart = source.indexOf('{', paramsEnd);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function compileTsFunction(source) {
  return transformSync(`module.exports = ${source};`, {
    loader: 'ts',
    format: 'cjs',
    target: 'es2022',
  }).code;
}

test('playback series resolution rejects stale cache, gateway, and direct A snapshots', async () => {
  const playbackSource = read('supabase/functions/norva-playback/index.ts');
  const playbackStart = playbackSource.indexOf('async function resolveSeriesEpisode(');
  const playbackEnd = playbackSource.indexOf('\nasync function resolveSeriesEpisodeUrl(', playbackStart);
  assert.ok(playbackStart >= 0 && playbackEnd > playbackStart);
  const compiled = compileTsFunction(playbackSource.slice(playbackStart, playbackEnd));

  class HttpError extends Error {
    constructor(status, message, details) {
      super(message);
      this.status = status;
      this.details = details;
    }
  }
  class ProviderDirectFallbackLeaseError extends Error {}
  class BoundedProviderResponseError extends Error {
    constructor(kind) {
      super(kind);
      this.kind = kind;
    }
  }
  const providerPayload = {
    info: { name: 'series-a' },
    episodes: { 1: [{ id: 'episode-a', container_extension: 'mkv' }] },
  };

  for (const rail of ['cache', 'gateway', 'direct']) {
    let currentRevision = '7';
    let releaseDelayed;
    let startedResolve;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    const delayed = new Promise((resolve) => { releaseDelayed = resolve; });
    let gatewayFetches = 0;
    let directFetches = 0;
    let releases = 0;
    let leaseHeld = false;
    let guardedWhileLease = false;

    const db = {
      from(table) {
        assert.equal(table, 'cloud_series_info_cache');
        return {
          select() { return this; },
          eq() { return this; },
          async maybeSingle() {
            if (rail !== 'cache') return { data: null };
            startedResolve();
            await delayed;
            return { data: { payload: providerPayload } };
          },
        };
      },
    };
    const sandbox = {
      module: { exports: {} },
      exports: {},
      URL,
      HttpError,
      ProviderDirectFallbackLeaseError,
      BoundedProviderResponseError,
      loadSourceConfigEnvelope: async () => ({
        config: { serverUrl: 'https://provider.example', username: 'user-a', password: 'password-a' },
        configRevision: '7',
        configCiphertext: 'ciphertext-a',
      }),
      stringOr: (value, fallback) => typeof value === 'string' && value ? value : fallback,
      normalizeBaseUrl: (value) => value,
      isRecord: (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
      recordOrEmpty: (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value : {},
      xtreamStreamUrl: ({ streamId }) => `https://provider.example/series/user-a/password-a/${streamId}.mkv`,
      getRuntimeConfig: async () => rail === 'gateway'
        ? { mediaGatewayUrl: 'https://gateway.invalid', mediaGatewayToken: 'gateway-token' }
        : { mediaGatewayUrl: '', mediaGatewayToken: '' },
      fetchBoundedProviderJson: async (url) => {
        if (String(url).includes('gateway.invalid')) gatewayFetches += 1;
        else directFetches += 1;
        startedResolve();
        await delayed;
        return { response: { ok: true }, value: providerPayload };
      },
      assertPlaybackSourceConfigCurrent: async (_sourceId, _userId, expectedRevision) => {
        if (leaseHeld) guardedWhileLease = true;
        if (expectedRevision !== currentRevision) {
          throw new HttpError(409, 'source changed', { code: 'SOURCE_CONFIG_REVISION_CHANGED' });
        }
      },
      isPlaybackSourceSnapshotError: (error) => error instanceof HttpError &&
        error.details?.code === 'SOURCE_CONFIG_REVISION_CHANGED',
      withSourceDirectFallbackLease: async (_context, operation) => {
        leaseHeld = true;
        try {
          return await operation();
        } finally {
          leaseHeld = false;
          releases += 1;
        }
      },
      providerDirectFallbackLeaseOwner: () => OWNER,
      directFallbackLeaseTtlSeconds: () => 30,
      buildProviderDirectFallbackSnapshot: async () => SNAPSHOT_PROOF,
    };
    vm.runInNewContext(compiled, sandbox, { filename: 'supabase/functions/norva-playback/index.ts' });

    const pending = sandbox.module.exports(SOURCE_ID, 'series-a', USER_ID, db);
    await started;
    currentRevision = '8';
    releaseDelayed();
    await assert.rejects(
      pending,
      (error) => error instanceof HttpError && error.status === 409 &&
        error.details?.code === 'SOURCE_CONFIG_REVISION_CHANGED',
      rail,
    );
    assert.equal(gatewayFetches, rail === 'gateway' ? 1 : 0, rail);
    assert.equal(directFetches, rail === 'direct' ? 1 : 0, rail);
    assert.equal(releases, rail === 'direct' ? 1 : 0, rail);
    if (rail === 'direct') assert.equal(guardedWhileLease, true, rail);
  }
});

test('playback direct oversize and timeout terminate before lease release', async () => {
  const playbackSource = read('supabase/functions/norva-playback/index.ts');
  const playbackStart = playbackSource.indexOf('async function resolveSeriesEpisode(');
  const playbackEnd = playbackSource.indexOf('\nasync function resolveSeriesEpisodeUrl(', playbackStart);
  assert.ok(playbackStart >= 0 && playbackEnd > playbackStart);
  const compiled = compileTsFunction(playbackSource.slice(playbackStart, playbackEnd));
  class HttpError extends Error {
    constructor(status, message, details) {
      super(message);
      this.status = status;
      this.details = details;
    }
  }
  class ProviderDirectFallbackLeaseError extends Error {}
  class BoundedProviderResponseError extends Error {
    constructor(kind) {
      super(kind);
      this.kind = kind;
    }
  }

  for (const kind of ['too_large', 'timeout']) {
    let transportTerminated = false;
    let releaseAfterTermination = false;
    let leaseHeld = false;
    let guardedWhileLease = false;
    const db = {
      from() {
        return {
          select() { return this; },
          eq() { return this; },
          async maybeSingle() { return { data: null }; },
        };
      },
    };
    const sandbox = {
      module: { exports: {} },
      exports: {},
      URL,
      HttpError,
      ProviderDirectFallbackLeaseError,
      BoundedProviderResponseError,
      loadSourceConfigEnvelope: async () => ({
        config: { serverUrl: 'https://provider.example', username: 'user-a', password: 'password-a' },
        configRevision: '7',
        configCiphertext: 'ciphertext-a',
      }),
      stringOr: (value, fallback) => typeof value === 'string' && value ? value : fallback,
      normalizeBaseUrl: (value) => value,
      isRecord: (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
      recordOrEmpty: (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value : {},
      xtreamStreamUrl: () => 'must-not-be-returned',
      getRuntimeConfig: async () => ({ mediaGatewayUrl: '', mediaGatewayToken: '' }),
      fetchBoundedProviderJson: async () => {
        transportTerminated = true;
        throw new BoundedProviderResponseError(kind);
      },
      assertPlaybackSourceConfigCurrent: async () => {
        if (leaseHeld) guardedWhileLease = true;
      },
      isPlaybackSourceSnapshotError: () => false,
      withSourceDirectFallbackLease: async (_context, operation) => {
        leaseHeld = true;
        try {
          return await operation();
        } finally {
          releaseAfterTermination = transportTerminated;
          leaseHeld = false;
        }
      },
      providerDirectFallbackLeaseOwner: () => OWNER,
      directFallbackLeaseTtlSeconds: () => 30,
      buildProviderDirectFallbackSnapshot: async () => SNAPSHOT_PROOF,
    };
    vm.runInNewContext(compiled, sandbox, { filename: 'supabase/functions/norva-playback/index.ts' });

    const result = await sandbox.module.exports(SOURCE_ID, 'series-a', USER_ID, db);
    assert.equal(result.url, null, kind);
    assert.equal(result.emptySeries, false, kind);
    assert.equal(releaseAfterTermination, true, kind);
    assert.equal(guardedWhileLease, true, kind);
  }
});

test('shared detection/sync and overview helpers cannot bypass a refused claim', async () => {
  const lease = await leaseModule();
  for (const file of [
    'supabase/functions/_shared/xtream-sync.ts',
    'supabase/functions/norva-source-sync/index.ts',
  ]) {
    const source = read(file);
    const compiled = compileTsFunction(extractFunction(source, 'fetchProviderMetadata'));
    const sandbox = {
      module: { exports: {} },
      exports: {},
      console: { warn() {} },
      HttpError: class HttpError extends Error {
        constructor(status, message, details) {
          super(message);
          this.status = status;
          this.details = details;
        }
      },
      ProviderDirectFallbackLeaseError: lease.ProviderDirectFallbackLeaseError,
      requestGatewayMetadata: async () => { throw new Error('gateway must not run'); },
      isGatewayBackgroundBusy: () => false,
      GATEWAY_BUSY_RETRY_DELAYS_MS: [],
      setTimeout,
      fetchJson: async () => { throw new Error('DIRECT_FETCH_EXECUTED'); },
      xtreamApiUrl: () => 'https://provider.example/player_api.php?username=secret',
    };
    vm.runInNewContext(compiled, sandbox, { filename: file });
    const fetchProviderMetadata = sandbox.module.exports;
    let directFetches = 0;
    sandbox.fetchJson = async () => { directFetches++; return {}; };
    const calls = [];
    const db = fakeDb([{
      data: null,
      error: { code: '55P03', details: 'reason=transition_active' },
    }], calls);

    await assert.rejects(
      fetchProviderMetadata(
        { mediaGatewayUrl: '', mediaGatewayToken: '' },
        { serverUrl: 'https://provider.example', username: 'hidden', password: 'hidden', action: 'get_vod_info' },
        {
          runDirectFallback: lease.createSourceDirectFallbackLeaseRunner({
            db,
            sourceId: SOURCE_ID,
            userId: USER_ID,
            ownerScope: 'runtime-test',
            ...SNAPSHOT_PROOF,
          }),
        },
      ),
      (error) => error?.status === 503 && error?.details?.code === lease.PROVIDER_DIRECT_FALLBACK_ERROR_CODE,
      file,
    );
    assert.equal(directFetches, 0, file);
    assert.equal(calls.length, 1, file);
  }

  const xtream = read('supabase/functions/_shared/xtream-sync.ts');
  assert.match(xtream, /detectXtreamChange[\s\S]*createSourceDirectFallbackLeaseRunner[\s\S]*fetchProviderMetadata\([\s\S]*\{ runDirectFallback \}/);
  assert.match(xtream, /driveXtreamSyncToReady[\s\S]*createSourceDirectFallbackLeaseRunner[\s\S]*fetchProviderMetadata\([\s\S]*\{ runDirectFallback \}/);
  const overview = read('supabase/functions/norva-source-sync/index.ts');
  assert.match(overview, /runProviderOverviewFleetLane[\s\S]*createSourceDirectFallbackLeaseRunner[\s\S]*fetchProviderMetadata\([\s\S]*\{ runDirectFallback \}/);
});

test('every existing-source Xtream direct rail is wired through the atomic lease', () => {
  const xtream = read('supabase/functions/_shared/xtream-sync.ts');
  const projection = read('supabase/functions/_shared/vod-title-projection.ts');
  const sourceSync = read('supabase/functions/norva-source-sync/index.ts');
  const cloud = read('supabase/functions/norva-cloud/index.ts');
  const seriesInfo = read('supabase/functions/norva-series-info/index.ts');
  const prewarm = read('supabase/functions/norva-series-prewarm/index.ts');
  const playback = read('supabase/functions/norva-playback/index.ts');

  assert.match(xtream, /directFallback\.runDirectFallback\([\s\S]*xtreamApiUrl/);
  assert.match(sourceSync, /owner: providerDirectFallbackLeaseOwner\("series-inventory"\)[\s\S]*fetchJson\(providerUrl/);
  assert.match(sourceSync, /directFallback\.runDirectFallback\([\s\S]*xtreamApiUrl/);
  assert.match(projection, /fetchVodInfo\([\s\S]*runDirectFallback[\s\S]*fetchJson\(xtreamApiUrl/);
  assert.match(projection, /fetchJsonWithHeaders[\s\S]*fetchBoundedProviderJson\(url[\s\S]*maxBytes: 8 \* 1024 \* 1024/);
  assert.doesNotMatch(extractFunction(projection, 'projectVodTitleGenerationIsolated'), /fetchVodInfo|fetchJson|xtreamConfig/);
  const sourceConnection = extractFunction(cloud, 'testSourceConnection');
  assert.match(sourceConnection, /buildProviderDirectFallbackSnapshot/);
  assert.match(sourceConnection, /validateCloudSource\([\s\S]*directFallback/);
  assert.match(sourceConnection, /type === "m3u"[\s\S]*withM3uSourceLease[\s\S]*else[\s\S]*await validate\(\)/);
  assert.match(cloud, /withExistingXtreamDirectFallback[\s\S]*cloud-series-info/);
  assert.match(cloud, /directEpg[\s\S]*withExistingXtreamDirectFallback/);
  const sourceEpg = extractFunction(cloud, 'getSourceEpg');
  assert.match(sourceEpg, /sourceType === "xtream"[\s\S]*xtreamDirectEpg = true/);
  assert.match(sourceEpg, /xtreamDirectEpg[\s\S]*"cloud-xmltv-epg"[\s\S]*fetchEpgXml/);
  assert.match(sourceEpg, /sourceType === "epg"[\s\S]*epgUrl = stringOr[\s\S]*: await fetchEpgXml\(\)/);
  assert.match(seriesInfo, /owner: providerDirectFallbackLeaseOwner\("series-info"\)[\s\S]*xtreamApiUrl/);
  assert.match(prewarm, /owner: providerDirectFallbackLeaseOwner\("series-prewarm-account"\)[\s\S]*fetchBoundedProviderJson\(url[\s\S]*maxBytes: 1024 \* 1024/);
  assert.match(playback, /owner: providerDirectFallbackLeaseOwner\("playback-series-resolution"\)[\s\S]*fetchBoundedProviderJson\(api/);
  assert.doesNotMatch(playback, /withSourceDirectFallbackLease\([\s\S]{0,800}\)\s*;[\s\S]{0,300}\.json\(/);
  const seriesResolution = playback.slice(
    playback.indexOf('async function resolveSeriesEpisode('),
    playback.indexOf('\nasync function resolveSeriesEpisodeUrl('),
  );
  assert.match(seriesResolution, /cachedEpisodeUrl[\s\S]*await assertLoadedSourceCurrent\(\)[\s\S]*return \{ url: cachedEpisodeUrl/);
  assert.match(seriesResolution, /mediaGatewayUrl[\s\S]*fetchBoundedProviderJson[\s\S]*maxBytes: 8 \* 1024 \* 1024/);
  assert.match(seriesResolution, /withSourceDirectFallbackLease[\s\S]*fetchBoundedProviderJson\(api[\s\S]*await assertLoadedSourceCurrent\(\)/);
  assert.match(seriesResolution, /await assertLoadedSourceCurrent\(\);[\s\S]*if \(!directInfo\) return miss/);
  assert.doesNotMatch(seriesResolution, /resp\.json\(|response\.json\(/);

  // New-source validation is the sole direct Xtream path without a source id;
  // it is intentionally outside the transition domain.
  assert.match(cloud, /if \(!directFallback\)[\s\S]*return recordOrEmpty\(await directFetch\(\)\)/);
});

test('cloud exposes only the stable retryable code, never SQL lease reasons or identifiers', async () => {
  const cloudSource = read('supabase/functions/norva-cloud/index.ts');
  assert.match(
    cloudSource,
    /async function withExistingXtreamDirectFallback[\s\S]*ProviderDirectFallbackLeaseError[\s\S]*new HttpError\(error\.status, error\.message, error\.details\)/,
  );
  const cloudPublic = await import(pathToFileURL(path.join(
    ROOT,
    'supabase/functions/_shared/cloud-public-view.mjs',
  )).href);
  const sanitized = cloudPublic.sanitizeCloudErrorDetails({
    code: 'PROVIDER_DIRECT_FALLBACK_RETRYABLE',
    retryable: false,
    reason: 'transition_active',
    sqlstate: '55P03',
    sourceId: SOURCE_ID,
    userId: USER_ID,
    affinityHash: 'opaque-secret-hash',
  });
  assert.deepEqual(sanitized, {
    code: 'PROVIDER_DIRECT_FALLBACK_RETRYABLE',
    retryable: true,
  });
  const serialized = JSON.stringify(sanitized);
  for (const forbidden of [
    'transition_active', '55P03', SOURCE_ID, USER_ID, 'opaque-secret-hash', 'reason', 'affinity',
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);

  assert.deepEqual(cloudPublic.sanitizeCloudErrorDetails({
    code: 'UNTRUSTED_PROVIDER_CODE', retryable: true, reason: 'provider body',
  }), {});
});
