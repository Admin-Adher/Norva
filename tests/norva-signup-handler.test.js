'use strict';

// The handler's contract is an ORDER, and an order is only provable by watching
// the calls happen. An earlier version of this file asserted that
// `recordDecision` appeared above `fetch` in the source text, which demonstrates
// the layout of a file and stops being true the moment somebody moves a call
// into a helper. So the fake database and the fake upstream write into ONE
// shared timeline, and the assertions read indices in that timeline.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const { bundleTypescriptModule } = require('./helpers/bundle-typescript-module');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const SECRETS = {
  NORVA_SIGNUP_TOKEN_SECRET: 'token-secret-long-enough-to-pass-the-guard',
  NORVA_SIGNUP_IDEMPOTENCY_SECRET: 'idem-secret-long-enough-to-pass-the-guard',
  NORVA_ABUSE_HASH_KEY: 'hash-key-long-enough-to-pass-the-guard',
  NORVA_ABUSE_POLICY_VERSION: 'test-policy',
};
const env = { ...SECRETS, NORVA_ABUSE_ENFORCEMENT_ENABLED: 'false' };

// No `serve`, so importing the module does not start a server: the wiring block
// at the bottom of the handler is guarded on exactly that.
const previousDeno = globalThis.Deno;
globalThis.Deno = { env: { get: (name) => env[name] } };

const loading = Promise.all([
  bundleTypescriptModule(path.join(root, 'supabase/functions/norva-signup/index.ts')),
  bundleTypescriptModule(path.join(root, 'supabase/functions/_shared/edge-ingress.ts')),
  bundleTypescriptModule(path.join(root, 'supabase/functions/_shared/signup-form-token.ts')),
]);

test.after(async () => {
  await loading;
  if (previousDeno === undefined) delete globalThis.Deno;
  else globalThis.Deno = previousDeno;
});

const KEYS = { currentVersion: 2, current: 'k'.repeat(48), previousVersion: 1, previous: 'j'.repeat(48) };
const NOW = 1_700_000_000_000;
const ROUTE = '/functions/v1/norva-signup';
const EMAIL = 'runtime-probe-8371@gmail.com';
const PASSWORD = 'Pw-runtime-probe-8371!';

// ── the harness ─────────────────────────────────────────────────────────────

function harness(options = {}) {
  const timeline = [];
  const logs = [];
  const rpc = options.rpc || {};

  const db = {
    async rpc(name, args) {
      timeline.push({ name, args });
      if (typeof rpc[name] === 'function') return rpc[name](args, timeline);
      switch (name) {
        case 'abuse_ingress_request_consume':
          return { data: true, error: null };
        case 'abuse_velocity_touch': {
          // Echo the subject hashes back: the store maps replies by
          // `${dimension}:${subject_hash}`, so an invented hash reads as zero.
          const counts = options.velocityCounts || {};
          const rows = (args.p_entries || []).map((entry) => ({
            dimension: entry.dimension,
            subject_hash: entry.subject_hash,
            counts: counts[entry.dimension] || {},
          }));
          return { data: rows, error: null };
        }
        case 'abuse_signup_attempt_claim':
          return { data: options.claim || { outcome: 'claimed' }, error: null };
        case 'abuse_signup_attempt_settle':
          return { data: true, error: null };
        case 'abuse_signup_decision_record':
          return { data: 'decision-0001', error: null };
        default:
          return { data: null, error: null };
      }
    },
  };

  const deps = {
    db,
    fetchUpstream: async (url, init) => {
      timeline.push({ name: 'GOTRUE', url, init });
      if (options.upstream) return options.upstream(url, init);
      return new Response(JSON.stringify({ id: 'user-0001' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    now: () => NOW + 5000,
    issueToken: async (nowMs) => {
      timeline.push({ name: 'ISSUE_TOKEN' });
      const [, , tokens] = await loading;
      const issued = await tokens.issueFormToken(nowMs);
      return { token: issued.token };
    },
    log: (entry) => logs.push(entry),
    ingressKeys: KEYS,
    supabaseUrl: 'https://api.norva.tv',
    serviceKey: 'service-key-for-the-fake-upstream',
    signupEndpointVersion: 'norva-signup-v1',
  };

  const names = () => timeline.map((entry) => entry.name);
  return {
    deps,
    timeline,
    logs,
    names,
    gotrueCalls: () => timeline.filter((entry) => entry.name === 'GOTRUE'),
    indexOf: (name) => names().indexOf(name),
  };
}

// Ce que le handler verra reellement : Kong porte strip_path: true sur
// functions-v1, donc le prefixe /functions/v1 n'atteint jamais l'amont. Le test
// derive la route exactement comme le handler, sinon il validerait un contrat
// que la production ne respecte pas — c'est precisement ce qui est arrive.
const relativeRoute = (p) => p.replace(/^.*\/norva-signup/, '') || '/';

async function signedRequest(overrides = {}) {
  const [, ingress] = await loading;
  const routePath = overrides.path || ROUTE;
  const bodyValue = overrides.body === undefined ? {} : overrides.body;
  const raw = new TextEncoder().encode(
    typeof bodyValue === 'string' ? bodyValue : JSON.stringify(bodyValue),
  );
  const envelope = {
    version: ingress.INGRESS_VERSION,
    keyVersion: KEYS.currentVersion,
    audience: overrides.audience || ingress.INGRESS_AUDIENCE_SIGNUP,
    timestampMs: overrides.timestampMs || NOW,
    requestId: overrides.requestId || nodeCrypto.randomBytes(16).toString('hex'),
    method: 'POST',
    route: overrides.signedRoute ?? relativeRoute(routePath),
    contentType: 'application/json',
    bodyHash: await ingress.hashBody(raw),
    clientIp: overrides.clientIp || '88.163.67.137',
    asn: 3215,
    country: 'FR',
  };
  const signature = 'signature' in overrides
    ? overrides.signature
    : await ingress.signIngress(envelope, overrides.secret || KEYS.current);
  const headers = { 'content-type': 'application/json', ...overrides.extraHeaders };
  if (signature !== null) headers['x-norva-ingress'] = signature;
  return new Request(`https://api.norva.tv${routePath}`, { method: 'POST', headers, body: raw });
}

async function freshToken(nonce) {
  const [, , tokens] = await loading;
  return tokens.issueFormToken(NOW, nonce);
}

function payload(extra = {}) {
  return {
    email: EMAIL,
    password: PASSWORD,
    surface: 'web',
    authMethod: 'password',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/126.0',
    acceptLanguage: 'fr-FR,fr;q=0.9',
    ...extra,
  };
}

// ── the order, measured ─────────────────────────────────────────────────────

test('GoTrue is called with the SIGNED client IP as X-Forwarded-For', async () => {
  // Kong's auth-v1-signup already rate-limits /auth/v1/signup at 10/min and
  // 40/hour per source IP. This call reaches it from inside the Docker
  // network, so without this header Kong would see the edge container's own
  // address on every signup — one of two IPs, not the real caller's — and a
  // floor that looks like it protects account creation would in practice cap
  // the container instead of the abuser.
  const [mod] = await loading;
  const h = harness();
  const issued = await freshToken();
  await mod.handleSignup(
    await signedRequest({
      body: payload({ formToken: issued.token }),
      clientIp: '203.0.113.77',
    }),
    h.deps,
  );
  const call = h.timeline.find((entry) => entry.name === 'GOTRUE');
  assert.ok(call, 'GoTrue was called');
  assert.equal(call.init.headers['x-forwarded-for'], '203.0.113.77');
});

test('X-Forwarded-For never comes from a header the edge itself received', async () => {
  // The only legitimate source is the signed envelope. An edge function
  // reachable only through a verified envelope has no caller who should be
  // able to inject a forwarded-IP of their own choosing.
  const [mod] = await loading;
  const h = harness();
  const issued = await freshToken();
  await mod.handleSignup(
    await signedRequest({
      body: payload({ formToken: issued.token }),
      clientIp: '203.0.113.77',
      extraHeaders: { 'x-forwarded-for': '198.51.100.1, 198.51.100.2' },
    }),
    h.deps,
  );
  const call = h.timeline.find((entry) => entry.name === 'GOTRUE');
  assert.equal(call.init.headers['x-forwarded-for'], '203.0.113.77');
  assert.ok(!String(call.init.headers['x-forwarded-for']).includes('198.51.100'));
});

test('a malformed signed IP is dropped rather than forwarded as-is', async () => {
  // Defence in depth against header injection, not a real-world path today:
  // the one signer (functions/_shared/signup-ingress.ts) only ever sources
  // this from Cloudflare's own CF-Connecting-IP. Never refuses the signup over
  // it — an enrichment header is not worth failing a legitimate account over.
  const [mod] = await loading;
  const h = harness();
  const issued = await freshToken();
  const response = await mod.handleSignup(
    await signedRequest({
      body: payload({ formToken: issued.token }),
      clientIp: "1.2.3.4\r\nX-Injected: yes",
    }),
    h.deps,
  );
  assert.equal(response.status, 200);
  const call = h.timeline.find((entry) => entry.name === 'GOTRUE');
  assert.ok(!('x-forwarded-for' in call.init.headers));
});

test('the decision snapshot is written before GoTrue is ever called', async () => {
  const [mod] = await loading;
  const h = harness();
  const issued = await freshToken();
  const response = await mod.handleSignup(
    await signedRequest({ body: payload({ formToken: issued.token }) }),
    h.deps,
  );

  assert.equal(response.status, 200);
  const snapshot = h.indexOf('abuse_signup_decision_record');
  const upstream = h.indexOf('GOTRUE');
  assert.ok(snapshot >= 0, 'the decision was recorded');
  assert.ok(upstream >= 0, 'the upstream was called');
  // The snapshot has to be what was known at the moment of the signup. Written
  // afterwards, the outcome would colour the evidence.
  assert.ok(snapshot < upstream, `snapshot at ${snapshot}, GoTrue at ${upstream}`);
});

test('the whole sequence runs in the declared order', async () => {
  const [mod] = await loading;
  const h = harness();
  const issued = await freshToken();
  await mod.handleSignup(
    await signedRequest({ body: payload({ formToken: issued.token }) }),
    h.deps,
  );

  const order = h.names();
  const expected = [
    'abuse_ingress_request_consume',
    'abuse_signup_attempt_claim',
    'abuse_velocity_touch',
    'abuse_signup_decision_record',
    'GOTRUE',
    'abuse_signup_attempt_settle',
  ].map((name) => [name, order.indexOf(name)]);
  for (const [name, index] of expected) assert.ok(index >= 0, `${name} never happened`);
  for (let i = 1; i < expected.length; i += 1) {
    assert.ok(
      expected[i - 1][1] < expected[i][1],
      `${expected[i - 1][0]} must precede ${expected[i][0]}`,
    );
  }
});

test('an unsigned request touches neither the database nor GoTrue', async () => {
  const [mod] = await loading;
  const h = harness();
  const response = await mod.handleSignup(
    await signedRequest({ body: payload(), signature: null }),
    h.deps,
  );
  assert.equal(response.status, 401);
  // The refusal has to be cheap: the public edge will receive invalid signatures
  // whatever the design.
  assert.deepEqual(h.names(), [], 'nothing was reached');
});

test('a forged signature is refused before any scoring', async () => {
  const [mod] = await loading;
  const h = harness();
  const response = await mod.handleSignup(
    await signedRequest({ body: payload(), secret: 'x'.repeat(48) }),
    h.deps,
  );
  assert.equal(response.status, 401);
  assert.deepEqual(h.names(), []);
});

test('a body changed after signing is refused', async () => {
  const [mod, ingress] = await loading;
  const h = harness();
  const raw = new TextEncoder().encode(JSON.stringify(payload()));
  const envelope = {
    version: ingress.INGRESS_VERSION,
    keyVersion: KEYS.currentVersion,
    audience: ingress.INGRESS_AUDIENCE_SIGNUP,
    timestampMs: NOW,
    requestId: nodeCrypto.randomBytes(16).toString('hex'),
    method: 'POST',
    route: relativeRoute(ROUTE),
    contentType: 'application/json',
    bodyHash: await ingress.hashBody(raw),
    clientIp: '88.163.67.137',
    asn: 3215,
    country: 'FR',
  };
  const signature = await ingress.signIngress(envelope, KEYS.current);
  const tampered = new Request(`https://api.norva.tv${ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-norva-ingress': signature },
    body: JSON.stringify(payload({ email: 'someone-else@gmail.com' })),
  });

  const response = await mod.handleSignup(tampered, h.deps);
  assert.equal(response.status, 401);
  assert.deepEqual(h.names(), []);
});

test('a replayed request id stops at the consume call', async () => {
  const [mod] = await loading;
  const h = harness({
    rpc: { abuse_ingress_request_consume: () => ({ data: false, error: null }) },
  });
  const issued = await freshToken();
  const response = await mod.handleSignup(
    await signedRequest({ body: payload({ formToken: issued.token }) }),
    h.deps,
  );
  assert.equal(response.status, 409);
  assert.deepEqual(h.names(), ['abuse_ingress_request_consume']);
  assert.equal(h.gotrueCalls().length, 0);
});

// ── idempotency, measured ───────────────────────────────────────────────────

test('a memoised success answers without calling GoTrue at all', async () => {
  const [mod] = await loading;
  const h = harness({
    claim: {
      outcome: 'replay',
      state: 'SUCCESS',
      result: { user_id: 'user-0001', email_confirmation_required: true, created: true },
      attempt_count: 2,
    },
  });
  const issued = await freshToken();
  const response = await mod.handleSignup(
    await signedRequest({ body: payload({ formToken: issued.token }) }),
    h.deps,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: 'ok',
    user_id: 'user-0001',
    email_confirmation_required: true,
    created: true,
  });
  // The whole point of idempotency: the second click does not reach GoTrue.
  assert.equal(h.gotrueCalls().length, 0, 'gotrueCallCount must be 0 on a replay');
  // But it is still observed, so the retry shows up in the distributions.
  assert.ok(h.indexOf('abuse_signup_decision_record') >= 0);
});

test('a replay still pending answers 202 and calls nothing upstream', async () => {
  const [mod] = await loading;
  const h = harness({
    claim: { outcome: 'replay', state: 'PROCESSING', result: null, attempt_count: 2 },
  });
  const issued = await freshToken();
  const response = await mod.handleSignup(
    await signedRequest({ body: payload({ formToken: issued.token }) }),
    h.deps,
  );
  assert.equal(response.status, 202);
  assert.equal(h.gotrueCalls().length, 0);
});

test('a replay of a final failure repeats the refusal, not the call', async () => {
  const [mod] = await loading;
  const h = harness({
    claim: { outcome: 'replay', state: 'FAILED_FINAL', result: null, attempt_count: 2 },
  });
  const issued = await freshToken();
  const response = await mod.handleSignup(
    await signedRequest({ body: payload({ formToken: issued.token }) }),
    h.deps,
  );
  assert.equal(response.status, 400);
  assert.equal(h.gotrueCalls().length, 0);
});

test('the same nonce with another intent is refused, never given the first result', async () => {
  const [mod] = await loading;
  const h = harness({ claim: { outcome: 'intent_mismatch' } });
  const issued = await freshToken();
  const response = await mod.handleSignup(
    await signedRequest({ body: payload({ formToken: issued.token }) }),
    h.deps,
  );
  assert.equal(response.status, 409);
  assert.equal(h.gotrueCalls().length, 0);
  const body = await response.json();
  assert.ok(!JSON.stringify(body).includes('user-0001'), 'no previous result leaks');
});

test('the password is part of the intent, so a different one is a different request', async () => {
  const [mod] = await loading;
  const fingerprints = [];
  const rpc = {
    abuse_signup_attempt_claim: (args) => {
      fingerprints.push(args.p_fingerprint);
      return { data: { outcome: 'claimed' }, error: null };
    },
  };
  const issued = await freshToken();
  for (const password of [PASSWORD, `${PASSWORD}-other`]) {
    const h = harness({ rpc });
    await mod.handleSignup(
      await signedRequest({ body: payload({ formToken: issued.token, password }) }),
      h.deps,
    );
  }
  assert.equal(fingerprints.length, 2);
  assert.notEqual(fingerprints[0], fingerprints[1], 'the credential is bound into the fingerprint');
  assert.ok(!fingerprints[0].includes(PASSWORD), 'and never stored in the clear');
});

// ── the vicious one: a maximal score with enforcement off ───────────────────

test('a CRITICAL score with enforcement off changes nothing about the product', async () => {
  const [mod] = await loading;
  let recorded = null;
  const h = harness({
    // Enough velocity to saturate the family cap, on top of a filled honeypot.
    velocityCounts: {
      ip: { 3600: 400, 86400: 900 },
      ip_subnet_24: { 3600: 400 },
      email: { 3600: 50 },
      mailbox_subject: { 86400: 200 },
    },
    rpc: {
      abuse_signup_decision_record: (args) => {
        recorded = args.p_decision;
        return { data: 'decision-critical', error: null };
      },
    },
  });
  const response = await mod.handleSignup(
    await signedRequest({
      body: payload({
        formToken: null,
        honeypot: 'filled by a bot',
        userAgent: null,
        acceptLanguage: null,
      }),
    }),
    h.deps,
  );

  assert.ok(recorded, 'a snapshot was written');
  assert.equal(recorded.observed_risk_score, 100, 'the score is clamped at the top');
  assert.equal(recorded.observed_risk_level, 'CRITICAL');
  assert.notEqual(recorded.would_have_decision, 'ALLOW', 'enforcing, this would have been refused');
  // Everything the mission asks for: the account is created anyway.
  assert.equal(recorded.actual_decision, 'ALLOW');
  assert.equal(recorded.enforcement_enabled, false);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'ok');
  assert.equal(h.gotrueCalls().length, 1, 'GoTrue was called exactly once');
  // This request carried no form token, so there was no nonce to memoise
  // against and nothing to settle. Worth stating rather than papering over: a
  // client too old to send a token gets no idempotency, only GoTrue's own
  // uniqueness on the address. That is the whole reason distributions are read
  // per `signup_endpoint_version` instead of in one block.
  assert.deepEqual(h.names().filter((name) => name.endsWith('_settle')), []);
  // No second effect anywhere: no quarantine, no trial restriction, no extra call.
  const unexpected = h.names().filter((name) => !name.startsWith('abuse_') && name !== 'GOTRUE');
  assert.deepEqual(unexpected, [], 'nothing else was touched');
});

test('the response body is identical whether the score is low or maximal', async () => {
  const [mod] = await loading;
  const bodies = [];
  for (const extra of [{}, { honeypot: 'x', userAgent: null, acceptLanguage: null }]) {
    const h = harness({ velocityCounts: { ip: { 3600: 400, 86400: 900 } } });
    const issued = await freshToken();
    const response = await mod.handleSignup(
      await signedRequest({ body: payload({ formToken: issued.token, ...extra }) }),
      h.deps,
    );
    bodies.push(await response.text());
  }
  // A caller must not be able to read its own score from the reply.
  assert.equal(bodies[0], bodies[1]);
});

// ── failure modes ───────────────────────────────────────────────────────────

test('a broken velocity store refuses nobody', async () => {
  const [mod] = await loading;
  const h = harness({
    rpc: { abuse_velocity_touch: () => ({ data: null, error: { code: '42P01' } }) },
  });
  const issued = await freshToken();
  const response = await mod.handleSignup(
    await signedRequest({ body: payload({ formToken: issued.token }) }),
    h.deps,
  );
  assert.equal(response.status, 200);
  assert.equal(h.gotrueCalls().length, 1, 'the account is still created');
  assert.ok(h.logs.some((entry) => entry.event === 'signup_velocity_unavailable'));
});

test('a lost decision snapshot refuses nobody either', async () => {
  const [mod] = await loading;
  const h = harness({
    rpc: { abuse_signup_decision_record: () => ({ data: null, error: { code: '23514' } }) },
  });
  const issued = await freshToken();
  const response = await mod.handleSignup(
    await signedRequest({ body: payload({ formToken: issued.token }) }),
    h.deps,
  );
  // Telemetry must never be the reason a signup fails.
  assert.equal(response.status, 200);
  assert.equal(h.gotrueCalls().length, 1);
});

test('an ambiguous upstream failure settles UNKNOWN and never retries', async () => {
  const [mod] = await loading;
  const settled = [];
  const h = harness({
    upstream: () => { throw new Error('socket hang up'); },
    rpc: {
      abuse_signup_attempt_settle: (args) => {
        settled.push(args.p_state);
        return { data: true, error: null };
      },
    },
  });
  const issued = await freshToken();
  const response = await mod.handleSignup(
    await signedRequest({ body: payload({ formToken: issued.token }) }),
    h.deps,
  );
  assert.equal(response.status, 202);
  // FAILED_FINAL here would let the retry create a second account.
  assert.deepEqual(settled, ['UNKNOWN']);
  assert.equal(h.gotrueCalls().length, 1, 'called once, not retried');
});

test('a deterministic upstream refusal settles FAILED_FINAL', async () => {
  const [mod] = await loading;
  const settled = [];
  const h = harness({
    upstream: () => new Response(JSON.stringify({ msg: 'already registered' }), { status: 422 }),
    rpc: {
      abuse_signup_attempt_settle: (args) => {
        settled.push(args.p_state);
        return { data: true, error: null };
      },
    },
  });
  const issued = await freshToken();
  const response = await mod.handleSignup(
    await signedRequest({ body: payload({ formToken: issued.token }) }),
    h.deps,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(settled, ['FAILED_FINAL']);
});

test('an already-registered email is a 200 with empty identities, not an error', async () => {
  // GoTrue's actual anti-enumeration behaviour, distinct from the generic
  // refusal above: no 4xx, an obfuscated user, an empty identities array, and
  // no confirmation email sent. account.html's existing UI depends on this
  // exact shape to say "this email already has an account" instead of a
  // dead-end "check your email" — losing the distinction here would silently
  // break that message for every signup this handler processes.
  const [mod] = await loading;
  let settledResult = null;
  const h = harness({
    upstream: () => new Response(
      JSON.stringify({ id: 'obfuscated-0001', identities: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
    rpc: {
      abuse_signup_attempt_settle: (args) => {
        settledResult = {
          created: args.p_created,
          alreadyRegistered: args.p_already_registered,
          emailConfirmationRequired: args.p_email_confirmation_required,
        };
        return { data: true, error: null };
      },
    },
  });
  const issued = await freshToken();
  const response = await mod.handleSignup(
    await signedRequest({ body: payload({ formToken: issued.token }) }),
    h.deps,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.already_registered, true);
  assert.equal(body.created, false);
  assert.equal(body.email_confirmation_required, false);
  assert.deepEqual(settledResult, {
    created: false,
    alreadyRegistered: true,
    emailConfirmationRequired: false,
  });
});

test('a genuinely new account is never flagged as already registered', async () => {
  const [mod] = await loading;
  const h = harness({
    upstream: () => new Response(
      JSON.stringify({ id: 'user-0001', identities: [{ id: 'ident-1' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  });
  const issued = await freshToken();
  const response = await mod.handleSignup(
    await signedRequest({ body: payload({ formToken: issued.token }) }),
    h.deps,
  );
  const body = await response.json();
  assert.equal(body.already_registered, false);
  assert.equal(body.created, true);
});

test('enforcement, once on, refuses at the one gated line', async () => {
  const [mod] = await loading;
  env.NORVA_ABUSE_ENFORCEMENT_ENABLED = 'true';
  try {
    const h = harness({ velocityCounts: { ip: { 3600: 400, 86400: 900 } } });
    const response = await mod.handleSignup(
      await signedRequest({
        body: payload({ formToken: null, honeypot: 'x', userAgent: null, acceptLanguage: null }),
      }),
      h.deps,
    );
    assert.equal(response.status, 429);
    assert.equal(h.gotrueCalls().length, 0, 'refused before the upstream');
    // Still observed: the snapshot exists whether or not the request was allowed.
    assert.ok(h.indexOf('abuse_signup_decision_record') >= 0);
  } finally {
    env.NORVA_ABUSE_ENFORCEMENT_ENABLED = 'false';
  }
});

// ── routes ──────────────────────────────────────────────────────────────────

test('health is liveness only and describes nothing internal', async () => {
  const [mod] = await loading;
  const h = harness();
  const response = await mod.handleSignup(
    new Request('https://api.norva.tv/functions/v1/norva-signup/health'),
    h.deps,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  // A readiness probe listing which secrets are present would describe the
  // internal state of the system to anyone who asked.
  assert.deepEqual(Object.keys(body), ['ok']);
  assert.equal(body.ok, true);
  assert.deepEqual(h.names(), [], 'liveness costs nothing');
});

test('issuing a token touches no database at all', async () => {
  const [mod, , tokens] = await loading;
  const h = harness();
  const response = await mod.handleSignup(
    await signedRequest({ body: {}, path: `${ROUTE}/token` }),
    h.deps,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  const verdict = await tokens.verifyFormToken(body.token, NOW + 6000);
  assert.equal(verdict.state, 'TOKEN_VALID_FRESH');
  // Otherwise flooding this route would mean flooding Postgres, which is the
  // problem the token exists to reduce. Not even the request id is consumed.
  assert.deepEqual(h.names().filter((name) => name.startsWith('abuse_')), []);
});

test('an envelope signed for another route cannot be used here', async () => {
  const [mod] = await loading;
  const h = harness();
  const response = await mod.handleSignup(
    await signedRequest({ body: payload(), path: ROUTE, signedRoute: '/token' }),
    h.deps,
  );
  assert.equal(response.status, 401);
  assert.deepEqual(h.names(), []);
});

test('an unknown route is refused before the body is even verified', async () => {
  const [mod] = await loading;
  const h = harness();
  const response = await mod.handleSignup(
    await signedRequest({ body: payload(), path: `${ROUTE}/admin` }),
    h.deps,
  );
  assert.equal(response.status, 404);
  assert.deepEqual(h.names(), []);
});

// ── the logs, read as data ──────────────────────────────────────────────────

test('nothing the person typed reaches a log line', async () => {
  const [mod] = await loading;
  const h = harness({ velocityCounts: { ip: { 3600: 400, 86400: 900 } } });
  const issued = await freshToken();
  await mod.handleSignup(
    await signedRequest({
      body: payload({ formToken: issued.token, honeypot: 'a bot wrote this' }),
    }),
    h.deps,
  );

  assert.ok(h.logs.length > 0, 'something was logged');
  const dumped = JSON.stringify(h.logs);
  for (const secret of [EMAIL, PASSWORD, issued.token, 'a bot wrote this', 'runtime-probe-8371']) {
    assert.ok(!dumped.includes(secret), `a log carried ${secret.slice(0, 12)}…`);
  }
  // And every field really is a scalar or an array of scalars: an object would
  // be a place a payload could hide.
  for (const entry of h.logs) {
    for (const [key, value] of Object.entries(entry)) {
      const ok = value === null || value === undefined
        || ['string', 'number', 'boolean'].includes(typeof value)
        || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
      assert.ok(ok, `log field ${key} is not a scalar`);
    }
  }
});

test('an upstream exception is reported by name, never by object', async () => {
  const [mod] = await loading;
  const h = harness({
    upstream: () => { throw new Error(`connect ECONNREFUSED while sending ${PASSWORD}`); },
  });
  const issued = await freshToken();
  await mod.handleSignup(
    await signedRequest({ body: payload({ formToken: issued.token }) }),
    h.deps,
  );
  const entry = h.logs.find((line) => line.event === 'signup_upstream_unknown');
  assert.ok(entry, 'the failure was reported');
  assert.equal(entry.errorName, 'Error');
  // The message could contain anything the caller sent, so it is not read at all.
  assert.ok(!JSON.stringify(h.logs).includes(PASSWORD));
});

// ── the two properties that can only be structural ──────────────────────────

test('the logger has no shape a payload could be passed as', () => {
  const handler = read('supabase/functions/norva-signup/index.ts');
  const declaration = handler.slice(
    handler.indexOf('export interface SignupLogEvent'),
    handler.indexOf('export interface SignupDeps'),
  );
  assert.ok(declaration.length > 0, 'the interface exists');
  // An allow-list of named scalars, so there is no `fields: Record<string,
  // unknown>` for a body to travel in. The earlier argument that an unbound
  // `catch {}` prevented this was simply wrong: `catch (error)` does not pull
  // `request` into scope, and a bare catch does not stop anyone logging a body.
  assert.ok(!/Record<string,\s*unknown>/.test(declaration));
  assert.ok(!/:\s*(object|any|unknown)\b/.test(declaration));
  const fields = [...declaration.matchAll(/^ {2}(\w+)\??: ([^;]+);/gm)];
  assert.ok(fields.length >= 10, `expected the full field list, found ${fields.length}`);
  for (const field of fields) {
    assert.match(field[2], /^(string|number|boolean)( \| null)?$|^string\[\]$/, field[1]);
  }
});

test('every refusal looks the same from outside', () => {
  const handler = read('supabase/functions/norva-signup/index.ts');
  const proxy = read('functions/_shared/signup-ingress.ts');
  // "Your IP has created 3 accounts and our maximum is 3" tells an attacker
  // exactly what to pace against. The reason lives in the logs and the snapshot.
  for (const source of [handler, proxy]) {
    assert.match(source, /Unable to complete registration\. Please try again later\./);
  }
  const shapes = new Set(
    [...handler.matchAll(/JSON\.stringify\(\{\s*error:[^)]*\)/g)]
      .map((match) => match[0].replace(/\s+/g, ' ')),
  );
  assert.equal(shapes.size, 1, 'exactly one refusal body in the handler');
});
