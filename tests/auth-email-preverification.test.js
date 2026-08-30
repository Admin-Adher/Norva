'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const { bundleTypescriptModule } = require('./helpers/bundle-typescript-module');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const previousDeno = globalThis.Deno;
const env = {
  NORVA_ABUSE_HASH_KEY: 'mailbox-proof-hash-key-long-enough-for-production-shape',
  PUBLIC_SITE_URL: 'https://norva.tv',
};
globalThis.Deno = { env: { get: (name) => env[name] } };

const loading = Promise.all([
  bundleTypescriptModule(path.join(root, 'supabase/functions/norva-auth-challenge/index.ts')),
  bundleTypescriptModule(path.join(root, 'supabase/functions/_shared/edge-ingress.ts')),
]);

test.after(async () => {
  await loading;
  if (previousDeno === undefined) delete globalThis.Deno;
  else globalThis.Deno = previousDeno;
});

const KEYS = { currentVersion: 4, current: 'k'.repeat(48) };
const NOW = 1_800_000_000_000;

async function signedRequest(route, body, overrides = {}) {
  const [, ingress] = await loading;
  const raw = new TextEncoder().encode(JSON.stringify(body));
  const envelope = {
    version: ingress.INGRESS_VERSION,
    keyVersion: KEYS.currentVersion,
    audience: ingress.INGRESS_AUDIENCE_AUTH_CHALLENGE,
    timestampMs: NOW,
    requestId: nodeCrypto.randomBytes(16).toString('hex'),
    method: 'POST',
    route,
    contentType: 'application/json',
    bodyHash: await ingress.hashBody(raw),
    clientIp: '203.0.113.42',
    asn: 3215,
    country: 'FR',
  };
  const signature = await ingress.signIngress(envelope, KEYS.current);
  return new Request(`https://api.norva.tv/functions/v1/norva-auth-challenge${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-norva-ingress': overrides.signature ?? signature,
    },
    body: raw,
  });
}

function harness(options = {}) {
  const timeline = [];
  const logs = [];
  let sentCode = '';
  const db = {
    async rpc(name, args) {
      timeline.push({ name, args });
      if (name === 'abuse_ingress_request_consume') return { data: true, error: null };
      if (name === 'abuse_velocity_touch') {
        const rows = args.p_entries.map((entry) => ({
          dimension: entry.dimension,
          subject_hash: entry.subject_hash,
          counts: { 3600: options.velocity?.[entry.dimension] ?? 1 },
        }));
        return { data: rows, error: null };
      }
      if (name === 'auth_email_challenge_issue') return { data: true, error: null };
      if (name === 'auth_email_challenge_invalidate') return { data: true, error: null };
      if (name === 'auth_email_challenge_verify') {
        return { data: { status: options.proofStatus || 'verified' }, error: null };
      }
      return { data: null, error: null };
    },
  };
  return {
    timeline,
    logs,
    get sentCode() { return sentCode; },
    deps: {
      db,
      now: () => NOW + 1000,
      ingressKeys: KEYS,
      resolveMailDomain: async () => options.domainState || 'valid',
      sendChallenge: async (email, code, challengeId) => {
        timeline.push({ name: 'SEND_EMAIL', email, challengeId });
        sentCode = code;
        return options.transport !== false;
      },
      createAuthLink: async (email, metadata, redirectTo) => {
        timeline.push({ name: 'CREATE_AUTH_LINK', email, metadata, redirectTo });
        return { tokenHash: 'hashed-token-1', verificationType: options.verificationType || 'signup' };
      },
      log: (entry) => logs.push(entry),
    },
  };
}

test('request sends a code without touching Auth or storing raw mailbox data', async () => {
  const [mod] = await loading;
  const h = harness();
  const response = await mod.handleAuthChallenge(await signedRequest('/request', {
    email: 'Person@Example.com',
    metadata: { signup_source: 'account' },
    redirectTo: 'https://norva.tv/account.html?client=unified_email_otp',
  }), h.deps);

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.match(payload.challengeId, /^[0-9a-f-]{36}$/);
  assert.match(h.sentCode, /^\d{6}$/);
  assert.equal(h.timeline.some((entry) => entry.name === 'CREATE_AUTH_LINK'), false);
  const issue = h.timeline.find((entry) => entry.name === 'auth_email_challenge_issue');
  assert.match(issue.args.p_email_hash, /^[0-9a-f]{64}$/);
  assert.match(issue.args.p_code_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(issue.args).includes('person@example.com'));
  assert.ok(!JSON.stringify(issue.args).includes(h.sentCode));
  assert.ok(h.timeline.findIndex((entry) => entry.name === 'auth_email_challenge_issue')
    < h.timeline.findIndex((entry) => entry.name === 'SEND_EMAIL'));
});

test('an invalid or expired code never reaches Auth', async () => {
  const [mod] = await loading;
  const h = harness({ proofStatus: 'invalid' });
  const response = await mod.handleAuthChallenge(await signedRequest('/verify', {
    email: 'person@example.com',
    challengeId: nodeCrypto.randomUUID(),
    code: '123456',
    metadata: {},
    redirectTo: 'https://norva.tv/account.html',
  }), h.deps);
  assert.equal(response.status, 400);
  assert.equal(h.timeline.some((entry) => entry.name === 'CREATE_AUTH_LINK'), false);
});

test('a verified code is the only path that returns a one-time Auth token', async () => {
  const [mod] = await loading;
  const h = harness({ proofStatus: 'verified', verificationType: 'magiclink' });
  const response = await mod.handleAuthChallenge(await signedRequest('/verify', {
    email: 'person@example.com',
    challengeId: nodeCrypto.randomUUID(),
    code: '654321',
    metadata: { norva_signup_platform: 'web', role: 'admin' },
    redirectTo: 'https://norva.tv/account.html?client=unified_email_otp',
  }), h.deps);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    tokenHash: 'hashed-token-1',
    verificationType: 'magiclink',
  });
  assert.ok(h.timeline.findIndex((entry) => entry.name === 'auth_email_challenge_verify')
    < h.timeline.findIndex((entry) => entry.name === 'CREATE_AUTH_LINK'));
  assert.deepEqual(h.timeline.find((entry) => entry.name === 'CREATE_AUTH_LINK').metadata, {
    norva_signup_platform: 'web',
  });
});

test('bad domain, velocity overflow and unsigned traffic fail before delivery', async () => {
  const [mod] = await loading;
  const domain = harness({ domainState: 'invalid' });
  const domainResponse = await mod.handleAuthChallenge(await signedRequest('/request', {
    email: 'person@typo.invalid', metadata: {}, redirectTo: 'https://norva.tv/account.html',
  }), domain.deps);
  assert.equal(domainResponse.status, 422);
  assert.equal(domain.timeline.some((entry) => entry.name === 'SEND_EMAIL'), false);

  const velocity = harness({ velocity: { ip: 21 } });
  const velocityResponse = await mod.handleAuthChallenge(await signedRequest('/request', {
    email: 'person@example.com', metadata: {}, redirectTo: 'https://norva.tv/account.html',
  }), velocity.deps);
  assert.equal(velocityResponse.status, 429);
  assert.equal(velocity.timeline.some((entry) => entry.name === 'SEND_EMAIL'), false);

  const unsigned = harness();
  const unsignedResponse = await mod.handleAuthChallenge(await signedRequest('/request', {
    email: 'person@example.com', metadata: {}, redirectTo: 'https://norva.tv/account.html',
  }, { signature: '1.bad.bad' }), unsigned.deps);
  assert.equal(unsignedResponse.status, 401);
  assert.equal(unsigned.timeline.length, 0);
});

test('production wiring keeps challenge storage private and the UI fail-closed', () => {
  const migration = read('supabase/migrations/20260830025025_auth_email_preverification_challenges.sql');
  const account = read('public/account.html');
  const authApi = read('public/js/authApi.js');
  const proxy = read('functions/_shared/signup-ingress.ts');
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on table abuse_private\.auth_email_challenges[\s\S]*service_role/);
  assert.match(migration, /grant execute[\s\S]*auth_email_challenge_verify[\s\S]*to service_role/);
  assert.match(migration, /order by expires_at[\s\S]*limit 250/);
  assert.doesNotMatch(migration, /\bemail\s+(?:text|varchar)/i);
  assert.match(account, /No account is created until you enter the code/);
  assert.match(account, /Is this email correct\?/);
  assert.match(account, /Use suggestion/);
  assert.match(account, /Keep what I typed/);
  assert.match(account, /NorvaAuth\.requestEmailChallenge/);
  assert.match(account, /NorvaAuth\.verifyEmailChallenge[\s\S]*NorvaAuth\.verifyOtp/);
  const premium = account.slice(account.indexOf("trackAuth(opts.signup ? 'signup_started'"), account.indexOf('function sanitizeReturnTo'));
  assert.doesNotMatch(premium, /signInWithOtp[\s\S]*createUser:\s*true/);
  assert.match(authApi, /\/api\/auth-email-challenge-request/);
  assert.match(authApi, /\/api\/auth-email-challenge-verify/);
  assert.match(authApi, /new AbortController\(\)/);
  assert.doesNotMatch(authApi, /AbortSignal\.timeout/);
  assert.match(proxy, /INGRESS_AUDIENCE_AUTH_CHALLENGE/);
  assert.match(read('supabase/functions/norva-auth-challenge/index.ts'), /ALLOWED_METADATA_KEYS/);
});
