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

function jwt(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value))
    .toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.signature`;
}

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
      setItem(key, value) {
        values.set(key, String(value));
        options.onSetItem?.(key, String(value));
      },
      removeItem(key) { values.delete(key); },
    },
    location: { origin: 'https://norva.tv', hash: '', pathname: '/app', search: '' },
    history: { replaceState() {} },
    navigator: options.navigator || {},
    fetch: fetchImpl,
    atob(value) { return Buffer.from(value, 'base64').toString('utf8'); },
    URL,
    URLSearchParams,
    Date,
    Promise,
    Error,
    JSON,
    Math,
    setTimeout,
    clearTimeout,
  });
  window.window = window;
  vm.runInContext(source, context, { filename: 'public/js/authApi.js' });
  return { auth: window.NorvaAuth, values, cloudTokens };
}

test('NorvaAuth elevates an enrolled TOTP session to AAL2 and stores the returned session', async () => {
  const aal1 = jwt({ sub: 'user-1', aal: 'aal1', exp: 4_102_444_800 });
  const aal2 = jwt({ sub: 'user-1', aal: 'aal2', exp: 4_102_444_800 });
  const calls = [];
  const user = {
    id: 'user-1',
    factors: [{
      id: 'factor-totp-1',
      factor_type: 'totp',
      status: 'verified',
      friendly_name: 'Finance\u0000 principale',
    }],
  };
  const runtime = loadAuth(async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', body: options.body || '' });
    if (url.endsWith('/auth/v1/user')) return response(200, user);
    if (url.endsWith('/auth/v1/factors/factor-totp-1/challenge')) {
      return response(200, { id: 'challenge-1', type: 'totp' });
    }
    if (url.endsWith('/auth/v1/factors/factor-totp-1/verify')) {
      return response(200, {
        access_token: aal2,
        refresh_token: 'refresh-aal2',
        expires_in: 3600,
        token_type: 'bearer',
        user,
      });
    }
    return response(404, { message: 'not found' });
  });

  runtime.auth.setSession({
    access_token: aal1,
    refresh_token: 'refresh-aal1',
    expires_at: 4_102_444_800,
    user,
  });
  const status = await runtime.auth.getMfaStatus();
  assert.deepEqual(JSON.parse(JSON.stringify(status)), {
    currentLevel: 'aal1',
    nextLevel: 'aal2',
    factors: [{ id: 'factor-totp-1', type: 'totp', label: 'Finance principale' }],
  });

  const session = await runtime.auth.challengeAndVerifyMfa({
    code: '012345',
    factorId: 'factor-totp-1',
  });
  assert.equal(session.access_token, aal2);
  assert.equal(JSON.parse(runtime.values.get('norva-cloud-session')).access_token, aal2);
  assert.equal(runtime.cloudTokens.at(-1), aal2);
  assert.equal(calls.filter((call) => call.url.endsWith('/auth/v1/user')).length, 2);
  assert.deepEqual(
    JSON.parse(calls.find((call) => call.url.endsWith('/verify')).body),
    { challenge_id: 'challenge-1', code: '012345' },
  );
});

test('NorvaAuth rejects malformed MFA codes before contacting GoTrue', async () => {
  let calls = 0;
  const runtime = loadAuth(async () => {
    calls += 1;
    return response(500, {});
  });
  await assert.rejects(
    runtime.auth.challengeAndVerifyMfa({ code: '12345x' }),
    (error) => error?.code === 'mfa_code_invalid',
  );
  assert.equal(calls, 0);
});

test('NorvaAuth refuses a verification response that does not contain an AAL2 JWT', async () => {
  const aal1 = jwt({ sub: 'user-1', aal: 'aal1', exp: 4_102_444_800 });
  const user = {
    id: 'user-1',
    factors: [{ id: 'factor-totp-1', factor_type: 'totp', status: 'verified' }],
  };
  const runtime = loadAuth(async (url) => {
    if (url.endsWith('/auth/v1/user')) return response(200, user);
    if (url.endsWith('/challenge')) return response(200, { id: 'challenge-1' });
    if (url.endsWith('/verify')) {
      return response(200, { access_token: aal1, refresh_token: 'unchanged', user });
    }
    return response(404, {});
  });
  runtime.auth.setSession({
    access_token: aal1,
    refresh_token: 'refresh-aal1',
    expires_at: 4_102_444_800,
    user,
  });
  await assert.rejects(
    runtime.auth.challengeAndVerifyMfa({ code: '123456' }),
    (error) => error?.code === 'mfa_elevation_failed',
  );
  assert.equal(JSON.parse(runtime.values.get('norva-cloud-session')).access_token, aal1);
});

test('NorvaAuth serializes the rotating MFA session inside the refresh lock', async () => {
  const aal1 = jwt({ sub: 'user-1', aal: 'aal1', exp: 4_102_444_800 });
  const aal2 = jwt({ sub: 'user-1', aal: 'aal2', exp: 4_102_444_800 });
  const user = {
    id: 'user-1',
    factors: [{ id: 'factor-totp-1', factor_type: 'totp', status: 'verified' }],
  };
  let inLock = false;
  const events = [];
  const runtime = loadAuth(async (url) => {
    if (url.endsWith('/auth/v1/user')) return response(200, user);
    if (url.endsWith('/challenge')) {
      events.push(`challenge:${inLock}`);
      return response(200, { id: 'challenge-1' });
    }
    if (url.endsWith('/verify')) {
      events.push(`verify:${inLock}`);
      return response(200, {
        access_token: aal2,
        refresh_token: 'refresh-aal2',
        user,
      });
    }
    return response(404, {});
  }, {
    navigator: {
      locks: {
        async request(name, callback) {
          events.push(`lock:${name}`);
          inLock = true;
          try { return await callback(); } finally { inLock = false; }
        },
      },
    },
    onSetItem(key, value) {
      if (key !== 'norva-cloud-session') return;
      if (JSON.parse(value).access_token === aal2) events.push(`session:${inLock}`);
    },
  });
  runtime.auth.setSession({
    access_token: aal1,
    refresh_token: 'refresh-aal1',
    expires_at: 4_102_444_800,
    user,
  });

  await runtime.auth.challengeAndVerifyMfa({ code: '012345' });

  assert.deepEqual(events, [
    'lock:norva-session-refresh',
    'challenge:true',
    'verify:true',
    'session:true',
  ]);
});
