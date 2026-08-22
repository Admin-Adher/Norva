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
  const window = { NORVA_SUPABASE_URL: 'https://api.norva.tv' };
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

test('a bucket under the threshold uses the new pipeline, never touches GoTrue directly', async () => {
  const { fetch, calls } = fakeFetch({
    '/api/signup-token': response(200, { token: 'tok-1' }),
    '/api/signup': response(200, { status: 'ok', user_id: 'user-1', created: true, already_registered: false }),
  });
  const { auth } = loadAuth(fetch, { storage: { [KEY_BUCKET]: '0' } });
  await auth.signUp({ email: 'a@b.com', password: 'x'.repeat(12) });
  assert.deepEqual(calls.map((c) => c.path), ['/api/signup-token', '/api/signup']);
  assert.equal(calls[1].body.formToken, 'tok-1');
  assert.ok(!calls.some((c) => c.path.includes('/auth/v1/signup')), 'legacy GoTrue was never called');
});

test('a bucket at or above the threshold uses the legacy path, never touches the new pipeline', async () => {
  const { fetch, calls } = fakeFetch({
    '/auth/v1/signup?redirect_to=https%3A%2F%2Fnorva.tv%2Faccount.html': response(200, { id: 'user-1', identities: [{}] }),
  });
  const { auth } = loadAuth(fetch, { storage: { [KEY_BUCKET]: '100' } });
  await auth.signUp({ email: 'a@b.com', password: 'x'.repeat(12) });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].path.startsWith('/auth/v1/signup'));
});

test('the bucket is generated once and reused, not re-rolled on every signup', async () => {
  const { fetch, calls } = fakeFetch({
    '/auth/v1/signup?redirect_to=https%3A%2F%2Fnorva.tv%2Faccount.html': () => response(200, { id: 'user-1', identities: [{}] }),
  });
  const { auth, values } = loadAuth(fetch, {}); // no seeded bucket: must be generated
  await auth.signUp({ email: 'a@b.com', password: 'x'.repeat(12) });
  const first = values.get(KEY_BUCKET);
  assert.ok(first !== undefined, 'a bucket was generated and stored');
  await auth.signUp({ email: 'a2@b.com', password: 'x'.repeat(12) });
  assert.equal(values.get(KEY_BUCKET), first, 'the second signup reused the same bucket');
});

// ── the asymmetric fallback rule ─────────────────────────────────────────────

test('a token-fetch failure falls back to the legacy endpoint — nothing was ever sent', async () => {
  const { fetch, calls } = fakeFetch({
    '/api/signup-token': 'network-error',
    '/auth/v1/signup?redirect_to=https%3A%2F%2Fnorva.tv%2Faccount.html': response(200, { id: 'user-1', identities: [{}] }),
  });
  const { auth } = loadAuth(fetch, { storage: { [KEY_BUCKET]: '0' } });
  const result = await auth.signUp({ email: 'a@b.com', password: 'x'.repeat(12) });
  assert.deepEqual(calls.map((c) => c.path), ['/api/signup-token', '/auth/v1/signup?redirect_to=https%3A%2F%2Fnorva.tv%2Faccount.html']);
  assert.equal(result.id, 'user-1');
});

test('a token-fetch 503 falls back to the legacy endpoint the same way', async () => {
  const { fetch, calls } = fakeFetch({
    '/api/signup-token': response(503, { error: 'unavailable' }),
    '/auth/v1/signup?redirect_to=https%3A%2F%2Fnorva.tv%2Faccount.html': response(200, { id: 'user-1', identities: [{}] }),
  });
  const { auth } = loadAuth(fetch, { storage: { [KEY_BUCKET]: '0' } });
  await auth.signUp({ email: 'a@b.com', password: 'x'.repeat(12) });
  assert.deepEqual(calls.map((c) => c.path), ['/api/signup-token', '/auth/v1/signup?redirect_to=https%3A%2F%2Fnorva.tv%2Faccount.html']);
});

test('once /api/signup is dispatched, a 4xx is final and never reaches legacy GoTrue', async () => {
  const { fetch, calls } = fakeFetch({
    '/api/signup-token': response(200, { token: 'tok-1' }),
    '/api/signup': response(409, { error: 'Unable to complete registration. Please try again later.' }),
  });
  const { auth } = loadAuth(fetch, { storage: { [KEY_BUCKET]: '0' } });
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
  const { auth } = loadAuth(fetch, { storage: { [KEY_BUCKET]: '0' } });
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
  const { auth } = loadAuth(fetch, { storage: { [KEY_BUCKET]: '0' } });
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
  const { auth } = loadAuth(fetch, { storage: { [KEY_BUCKET]: '0' } });
  await assert.rejects(() => auth.signUp({ email: 'a@b.com', password: 'x'.repeat(12) }));
  const signupCalls = calls.filter((c) => c.path === '/api/signup');
  assert.ok(signupCalls.length >= 2, 'retried at least once before giving up');
  assert.ok(!calls.some((c) => c.path.includes('/auth/v1/signup')));
});

// ── response shape parity with the legacy anti-enumeration UI ───────────────

test('an already-registered result is shaped exactly like GoTrue\'s own anti-enumeration response', async () => {
  const { fetch } = fakeFetch({
    '/api/signup-token': response(200, { token: 'tok-1' }),
    '/api/signup': response(200, { status: 'ok', user_id: 'user-1', already_registered: true, created: false }),
  });
  const { auth } = loadAuth(fetch, { storage: { [KEY_BUCKET]: '0' } });
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
  const { auth } = loadAuth(fetch, { storage: { [KEY_BUCKET]: '0' } });
  const result = await auth.signUp({ email: 'a@b.com', password: 'x'.repeat(12) });
  assert.equal(result.user, undefined, 'must not hit the already-registered branch');
  assert.equal(result.id, 'user-1');
  assert.equal(result.identities.length, 1);
});
