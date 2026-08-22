'use strict';

// The canary is a client-side ROUTING decision, so these tests are behavioural:
// seed a bucket, call signUp(), and read which URLs actually got fetched. A test
// that inspected the source for "0.01" or "bucket" would prove the constant
// exists, not that a real browser with that bucket calls the right endpoint.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'public/js/authApi.js'),
  'utf8',
);

const KEY_BUCKET = 'norva-signup-canary-bucket';

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

function loadAuth(fetchImpl, options = {}) {
  const values = new Map(Object.entries(options.storage || {}));
  const window = {
    NORVA_SUPABASE_URL: 'https://api.norva.tv',
    // SIGNUP_PIPELINE_ENABLED is a shipped kill switch, currently false
    // (paused 2026-08-22). Tests that need to exercise the new pipeline set
    // this the same way manual QA would from devtools — a real, documented
    // override, not a test-only backdoor into the module's internals.
    __NORVA_FORCE_SIGNUP_PIPELINE__: options.forcePipeline,
  };
  const context = vm.createContext({
    window,
    localStorage: {
      getItem: (key) => (values.has(key) ? values.get(key) : null),
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
    location: { origin: 'https://norva.tv' },
    navigator: options.navigator || { userAgent: 'test-agent', language: 'en-US' },
    fetch: fetchImpl,
    crypto: globalThis.crypto,
    AbortController,
    URL,
    URLSearchParams,
    Date,
    Promise,
    Error,
    JSON,
    Math,
    Array,
    Number,
    String,
    setTimeout,
    clearTimeout,
  });
  window.window = window;
  vm.runInContext(source, context, { filename: 'public/js/authApi.js' });
  return { auth: window.NorvaAuth, values };
}

function fakeFetch(handlers) {
  const calls = [];
  return {
    calls,
    fetch: async (url, options = {}) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '');
      calls.push({ path, method: options.method, body: options.body ? JSON.parse(options.body) : null });
      const handler = handlers[path];
      if (!handler) throw new Error(`unhandled path in test: ${path}`);
      const outcome = typeof handler === 'function' ? handler(calls.length) : handler;
      if (outcome === 'network-error') throw new Error('simulated network failure');
      return outcome;
    },
  };
}

// ── which path a bucket takes ────────────────────────────────────────────────

test('LIVE: a bucket under the 1% threshold uses the new pipeline, with no override needed', async () => {
  // Re-enabled 2026-08-22 after the parity fix was confirmed against a real
  // production row (see the roadmap doc) — this exercises the actual shipped
  // switch position, not an assumption about it. No override is set: this is
  // exactly what a real browser with this bucket does today.
  const { fetch, calls } = fakeFetch({
    '/api/signup-token': response(200, { token: 'tok-1' }),
    '/api/signup': response(200, { status: 'ok', user_id: 'user-1', created: true, already_registered: false }),
  });
  const { auth } = loadAuth(fetch, { storage: { [KEY_BUCKET]: '0' } });
  await auth.signUp({ email: 'a@b.com', password: 'x'.repeat(12) });
  assert.deepEqual(calls.map((c) => c.path), ['/api/signup-token', '/api/signup']);
  assert.ok(!calls.some((c) => c.path.includes('/auth/v1/signup')), 'legacy GoTrue was never called');
});

test('LIVE: a bucket at or above the 1% threshold still uses legacy, with no override needed', async () => {
  const { fetch, calls } = fakeFetch({
    '/auth/v1/signup?redirect_to=https%3A%2F%2Fnorva.tv%2Faccount.html': response(200, { id: 'user-1', identities: [{}] }),
  });
  const { auth } = loadAuth(fetch, { storage: { [KEY_BUCKET]: '100' } });
  await auth.signUp({ email: 'a@b.com', password: 'x'.repeat(12) });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].path.startsWith('/auth/v1/signup'));
});

test('the force override routes a single tab through the new pipeline regardless of the bucket or the switch', async () => {
  // The documented devtools escape hatch for manual QA against production
  // without touching localStorage or the shipped switch: exactly what
  // "force bucket 0 to test" was standing in for, but it does not depend on
  // the RNG or require guessing which bucket a given browser already has.
  const { fetch, calls } = fakeFetch({
    '/api/signup-token': response(200, { token: 'tok-1' }),
    '/api/signup': response(200, { status: 'ok', user_id: 'user-1', created: true, already_registered: false }),
  });
  const { auth } = loadAuth(fetch, { forcePipeline: true, storage: { [KEY_BUCKET]: '9999' } });
  await auth.signUp({ email: 'a@b.com', password: 'x'.repeat(12) });
  assert.deepEqual(calls.map((c) => c.path), ['/api/signup-token', '/api/signup']);
  assert.equal(calls[1].body.formToken, 'tok-1');
  assert.ok(!calls.some((c) => c.path.includes('/auth/v1/signup')), 'legacy GoTrue was never called');
});

test('the force override can also pin a tab to legacy even with a qualifying bucket', async () => {
  const { fetch, calls } = fakeFetch({
    '/auth/v1/signup?redirect_to=https%3A%2F%2Fnorva.tv%2Faccount.html': response(200, { id: 'user-1', identities: [{}] }),
  });
  const { auth } = loadAuth(fetch, { forcePipeline: false, storage: { [KEY_BUCKET]: '0' } });
  await auth.signUp({ email: 'a@b.com', password: 'x'.repeat(12) });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].path.startsWith('/auth/v1/signup'));
});

test('a bucket is generated on first visit, whichever path the draw happens to qualify for', async () => {
  // Deliberately does NOT pin the outcome via forcePipeline: that override
  // skips signupCanaryBucket() entirely, which would prove nothing about
  // generation. Both endpoints are stubbed instead, so the test's own fake
  // network never depends on which way a real 1-in-10000 draw falls — the
  // property under test is generation-and-reuse, not which path was taken
  // (the two LIVE tests above already cover that).
  const { fetch, calls } = fakeFetch({
    '/auth/v1/signup?redirect_to=https%3A%2F%2Fnorva.tv%2Faccount.html': () => response(200, { id: 'user-1', identities: [{}] }),
    '/api/signup-token': () => response(200, { token: 'tok-1' }),
    '/api/signup': () => response(200, { status: 'ok', user_id: 'user-1', created: true, already_registered: false }),
  });
  const { auth, values } = loadAuth(fetch, {}); // no seeded bucket: must be generated
  await auth.signUp({ email: 'a@b.com', password: 'x'.repeat(12) });
  const first = values.get(KEY_BUCKET);
  assert.ok(first !== undefined, 'a bucket was generated and stored');
  await auth.signUp({ email: 'a2@b.com', password: 'x'.repeat(12) });
  assert.equal(values.get(KEY_BUCKET), first, 'the second signup reused the same bucket, not a freshly drawn one');
});

test('a stored bucket is read and reused, never regenerated, once it exists', async () => {
  const { fetch, calls } = fakeFetch({
    '/auth/v1/signup?redirect_to=https%3A%2F%2Fnorva.tv%2Faccount.html': () => response(200, { id: 'user-1', identities: [{}] }),
  });
  const { auth, values } = loadAuth(fetch, { storage: { [KEY_BUCKET]: '9999' } });
  await auth.signUp({ email: 'a@b.com', password: 'x'.repeat(12) });
  await auth.signUp({ email: 'a2@b.com', password: 'x'.repeat(12) });
  assert.equal(values.get(KEY_BUCKET), '9999', 'never overwritten by a new draw');
});

// ── the asymmetric fallback rule (pipeline forced on to exercise it) ────────

test('a token-fetch failure falls back to the legacy endpoint — nothing was ever sent', async () => {
  const { fetch, calls } = fakeFetch({
    '/api/signup-token': 'network-error',
    '/auth/v1/signup?redirect_to=https%3A%2F%2Fnorva.tv%2Faccount.html': response(200, { id: 'user-1', identities: [{}] }),
  });
  const { auth } = loadAuth(fetch, { forcePipeline: true });
  const result = await auth.signUp({ email: 'a@b.com', password: 'x'.repeat(12) });
  assert.deepEqual(calls.map((c) => c.path), ['/api/signup-token', '/auth/v1/signup?redirect_to=https%3A%2F%2Fnorva.tv%2Faccount.html']);
  assert.equal(result.id, 'user-1');
});

test('a token-fetch 503 falls back to the legacy endpoint the same way', async () => {
  const { fetch, calls } = fakeFetch({
    '/api/signup-token': response(503, { error: 'unavailable' }),
    '/auth/v1/signup?redirect_to=https%3A%2F%2Fnorva.tv%2Faccount.html': response(200, { id: 'user-1', identities: [{}] }),
  });
  const { auth } = loadAuth(fetch, { forcePipeline: true });
  await auth.signUp({ email: 'a@b.com', password: 'x'.repeat(12) });
  assert.deepEqual(calls.map((c) => c.path), ['/api/signup-token', '/auth/v1/signup?redirect_to=https%3A%2F%2Fnorva.tv%2Faccount.html']);
});

test('once /api/signup is dispatched, a 4xx is final and never reaches legacy GoTrue', async () => {
  const { fetch, calls } = fakeFetch({
    '/api/signup-token': response(200, { token: 'tok-1' }),
    '/api/signup': response(409, { error: 'Unable to complete registration. Please try again later.' }),
  });
  const { auth } = loadAuth(fetch, { forcePipeline: true });
  await assert.rejects(
    () => auth.signUp({ email: 'a@b.com', password: 'x'.repeat(12) }),
    /Unable to complete registration/,
  );
  assert.deepEqual(calls.map((c) => c.path), ['/api/signup-token', '/api/signup']);
});

test('once /api/signup is dispatched, a network error after sending is final and never reaches legacy GoTrue', async () => {
  const { fetch, calls } = fakeFetch({
    '/api/signup-token': response(200, { token: 'tok-1' }),
    '/api/signup': 'network-error',
  });
  const { auth } = loadAuth(fetch, { forcePipeline: true });
  await assert.rejects(() => auth.signUp({ email: 'a@b.com', password: 'x'.repeat(12) }));
  assert.deepEqual(calls.map((c) => c.path), ['/api/signup-token', '/api/signup']);
});

// ── 202 pending: retried idempotently, never as a fallback trigger ──────────

test('a 202 is retried with the IDENTICAL form token, and a later success is returned', async () => {
  // A counter scoped to THIS endpoint: the shared `calls` array also counts the
  // token request, which would shift the pending/success transition by one and
  // make the assertion pass or fail for the wrong reason.
  let signupAttempts = 0;
  const { fetch, calls } = fakeFetch({
    '/api/signup-token': response(200, { token: 'tok-retry' }),
    '/api/signup': () => {
      signupAttempts += 1;
      return signupAttempts <= 2
        ? response(202, { status: 'pending' })
        : response(200, { status: 'ok', user_id: 'user-1', created: true, already_registered: false });
    },
  });
  const { auth } = loadAuth(fetch, { forcePipeline: true });
  const result = await auth.signUp({ email: 'a@b.com', password: 'x'.repeat(12) });
  const signupCalls = calls.filter((c) => c.path === '/api/signup');
  assert.equal(signupCalls.length, 3, 'two pendings, then the resolving call');
  for (const call of signupCalls) assert.equal(call.body.formToken, 'tok-retry');
  assert.equal(result.id, 'user-1');
  assert.ok(!calls.some((c) => c.path.includes('/auth/v1/signup')));
});

test('a 202 that never resolves is surfaced as an error, still never falling back', async () => {
  const { fetch, calls } = fakeFetch({
    '/api/signup-token': response(200, { token: 'tok-stuck' }),
    '/api/signup': response(202, { status: 'pending' }),
  });
  const { auth } = loadAuth(fetch, { forcePipeline: true });
  await assert.rejects(() => auth.signUp({ email: 'a@b.com', password: 'x'.repeat(12) }));
  const signupCalls = calls.filter((c) => c.path === '/api/signup');
  assert.ok(signupCalls.length >= 2, 'retried at least once before giving up');
  assert.ok(!calls.some((c) => c.path.includes('/auth/v1/signup')));
});

// ── payload parity with the legacy direct-to-GoTrue call ────────────────────

test('displayName, signupContext and redirectTo reach /api/signup, not just email and password', async () => {
  // The gap found when this canary was first paused: the pipeline forwarded
  // only email and password, silently dropping the display name, attribution
  // metadata and confirmation redirect that legacySignUp has always sent.
  const { fetch, calls } = fakeFetch({
    '/api/signup-token': response(200, { token: 'tok-1' }),
    '/api/signup': response(200, { status: 'ok', user_id: 'user-1', created: true, already_registered: false }),
  });
  const { auth } = loadAuth(fetch, { forcePipeline: true });
  await auth.signUp({
    email: 'a@b.com',
    password: 'x'.repeat(12),
    displayName: 'Alex',
    signupContext: { norva_signup_platform: 'web', norva_signup_method: 'email_password' },
    redirectTo: 'https://norva.tv/account.html?returnTo=%2Fapp',
  });
  const sent = calls.find((c) => c.path === '/api/signup').body;
  assert.equal(sent.displayName, 'Alex');
  assert.equal(sent.redirectTo, 'https://norva.tv/account.html?returnTo=%2Fapp');
  assert.deepEqual(sent.signupContext, { norva_signup_platform: 'web', norva_signup_method: 'email_password' });
});

test('a missing redirectTo defaults the same way legacySignUp does', async () => {
  const { fetch, calls } = fakeFetch({
    '/api/signup-token': response(200, { token: 'tok-1' }),
    '/api/signup': response(200, { status: 'ok', user_id: 'user-1', created: true, already_registered: false }),
  });
  const { auth } = loadAuth(fetch, { forcePipeline: true });
  await auth.signUp({ email: 'a@b.com', password: 'x'.repeat(12) });
  const sent = calls.find((c) => c.path === '/api/signup').body;
  assert.equal(sent.redirectTo, 'https://norva.tv/account.html');
});

// ── response shape parity with the legacy anti-enumeration UI ───────────────

test('an already-registered result is shaped exactly like GoTrue\'s own anti-enumeration response', async () => {
  const { fetch } = fakeFetch({
    '/api/signup-token': response(200, { token: 'tok-1' }),
    '/api/signup': response(200, { status: 'ok', user_id: 'user-1', already_registered: true, created: false }),
  });
  const { auth } = loadAuth(fetch, { forcePipeline: true });
  const result = await auth.signUp({ email: 'a@b.com', password: 'x'.repeat(12) });
  // account.html's existing branch reads exactly this shape to show
  // "this email already has a Norva account" instead of a dead-end message.
  // Round-tripped through JSON: `result` was built inside the vm realm, so its
  // Object.prototype differs from this file's — deepEqual would otherwise fail
  // on prototype identity alone, not on any real difference in the data.
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { user: { id: 'user-1', identities: [] } });
});

test('a freshly created account is shaped so the existing "check your email" branch fires', async () => {
  const { fetch } = fakeFetch({
    '/api/signup-token': response(200, { token: 'tok-1' }),
    '/api/signup': response(200, { status: 'ok', user_id: 'user-1', already_registered: false, created: true }),
  });
  const { auth } = loadAuth(fetch, { forcePipeline: true });
  const result = await auth.signUp({ email: 'a@b.com', password: 'x'.repeat(12) });
  assert.equal(result.user, undefined, 'must not hit the already-registered branch');
  assert.equal(result.id, 'user-1');
  assert.equal(result.identities.length, 1);
});
