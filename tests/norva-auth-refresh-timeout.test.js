'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'public/js/authApi.js'),
  'utf8',
);

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

function loadAuth(fetchImpl, options = {}) {
  const values = new Map();
  const cloudTokens = [];
  const window = {
    NORVA_SUPABASE_URL: 'https://api.norva.tv',
    NORVA_SUPABASE_PUBLISHABLE_KEY: 'publishable-test',
    NorvaCloud: { setToken(token) { cloudTokens.push(token); } },
  };
  const context = vm.createContext({
    window,
    localStorage: {
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      setItem(key, value) { values.set(key, String(value)); },
      removeItem(key) { values.delete(key); },
    },
    location: { origin: 'https://norva.tv', hash: '', pathname: '/app', search: '' },
    history: { replaceState() {} },
    navigator: options.navigator || {},
    fetch: fetchImpl,
    atob(value) { return Buffer.from(value, 'base64').toString('utf8'); },
    AbortController,
    URL,
    URLSearchParams,
    Date,
    Promise,
    Error,
    JSON,
    Math,
    setTimeout: options.setTimeout || setTimeout,
    clearTimeout: options.clearTimeout || clearTimeout,
  });
  window.window = window;
  vm.runInContext(source, context, { filename: 'public/js/authApi.js' });
  return { auth: window.NorvaAuth, values, cloudTokens };
}

function expiredSession() {
  return {
    access_token: 'expired-access-token',
    refresh_token: 'still-valid-refresh-token',
    expires_at: 1,
    user: { id: 'user-1', email: 'member@example.test' },
  };
}

test('refresh lock timeout settles as transient and preserves the stored session', async () => {
  let fetchCalls = 0;
  const runtime = loadAuth(async () => {
    fetchCalls += 1;
    throw new Error('fetch must remain unreachable while the lock is held');
  }, {
    navigator: {
      locks: {
        request(_name, lockOptions) {
          return new Promise((resolve, reject) => {
            const rejectForAbort = () => reject(lockOptions.signal.reason || new Error('aborted'));
            if (lockOptions.signal.aborted) rejectForAbort();
            else lockOptions.signal.addEventListener('abort', rejectForAbort, { once: true });
          });
        },
      },
    },
    setTimeout(callback, delay) {
      assert.equal(delay, 7_000);
      Promise.resolve().then(callback);
      return 1;
    },
    clearTimeout() {},
  });
  runtime.auth.setSession(expiredSession());

  await assert.rejects(
    runtime.auth.refreshSession(),
    (error) => error?.code === 'auth_refresh_lock_timeout'
      && error?.transient === true
      && error?.definitive !== true,
  );

  assert.equal(fetchCalls, 0);
  assert.equal(
    JSON.parse(runtime.values.get('norva-cloud-session')).refresh_token,
    'still-valid-refresh-token',
  );
  assert.notEqual(runtime.cloudTokens.at(-1), null);
});

test('a Web Locks implementation whose query never settles uses the local lease fallback', async () => {
  let fetchCalls = 0;
  let lockRequests = 0;
  let lockQueries = 0;
  const scheduledDelays = [];
  const nativeSetTimeout = setTimeout;
  const runtime = loadAuth(async (url) => {
    fetchCalls += 1;
    assert.match(url, /\/auth\/v1\/token\?grant_type=refresh_token$/);
    return response(200, {
      access_token: 'fresh-access-token',
      refresh_token: 'fresh-refresh-token',
      expires_in: 3600,
      user: { id: 'user-1', email: 'member@example.test' },
    });
  }, {
    navigator: {
      locks: {
        query() {
          lockQueries += 1;
          return new Promise(() => {});
        },
        request() {
          lockRequests += 1;
          return new Promise(() => {});
        },
      },
    },
    setTimeout(callback, delay) {
      scheduledDelays.push(delay);
      return nativeSetTimeout(callback, delay === 250 ? 0 : delay);
    },
  });
  runtime.auth.setSession(expiredSession());

  const refreshed = await runtime.auth.refreshSession();

  assert.equal(refreshed.access_token, 'fresh-access-token');
  assert.equal(fetchCalls, 1);
  assert.equal(lockQueries, 1);
  assert.equal(lockRequests, 0, 'a failed capability probe must not enter the broken lock');
  assert.ok(scheduledDelays.includes(250));
  assert.equal(
    JSON.parse(runtime.values.get('norva-cloud-session')).refresh_token,
    'fresh-refresh-token',
  );
});

test('hung refresh requests settle after the bounded retry and preserve the session', async () => {
  const requestSignals = [];
  const scheduledDelays = [];
  const runtime = loadAuth(async (_url, options = {}) => {
    requestSignals.push(options.signal);
    return new Promise(() => {});
  }, {
    navigator: {
      locks: {
        async request(_name, _options, callback) { return callback(); },
      },
    },
    setTimeout(callback, delay) {
      scheduledDelays.push(delay);
      Promise.resolve().then(callback);
      return scheduledDelays.length;
    },
    clearTimeout() {},
  });
  runtime.auth.setSession(expiredSession());

  await assert.rejects(
    runtime.auth.refreshSession(),
    (error) => error?.code === 'auth_refresh_request_timeout'
      && error?.transient === true
      && error?.definitive !== true,
  );

  assert.equal(requestSignals.length, 2, 'one bounded retry is allowed');
  assert.ok(requestSignals.every((signal) => signal instanceof AbortSignal));
  assert.ok(requestSignals.every((signal) => signal.aborted));
  assert.deepEqual(scheduledDelays, [7_000, 8_000, 1_500, 8_000]);
  assert.equal(
    JSON.parse(runtime.values.get('norva-cloud-session')).access_token,
    'expired-access-token',
  );
});

test('a definitive refresh-token 401 still clears the stored session', async () => {
  let fetchCalls = 0;
  const runtime = loadAuth(async (url) => {
    fetchCalls += 1;
    assert.match(url, /\/auth\/v1\/token\?grant_type=refresh_token$/);
    return response(401, { message: 'Invalid Refresh Token' });
  }, {
    navigator: {
      locks: {
        async request(_name, _options, callback) { return callback(); },
      },
    },
  });
  runtime.auth.setSession(expiredSession());

  await assert.rejects(
    runtime.auth.refreshSession(),
    (error) => error?.status === 401 && error?.definitive === true,
  );

  assert.equal(fetchCalls, 1);
  assert.equal(runtime.values.has('norva-cloud-session'), false);
  assert.equal(runtime.cloudTokens.at(-1), null);
});
