const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const revolutSource = fs.readFileSync(
  path.join(root, 'supabase', 'functions', 'norva-revolut', 'index.ts'),
  'utf8'
).replace(/\r\n/g, '\n');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function extractRoute(methodPath, method = 'POST') {
  const marker = `if (req.method === "${method}" && path === "/${methodPath}") {`;
  const markerAt = revolutSource.indexOf(marker);
  assert.ok(markerAt >= 0, `/${methodPath} route not found`);
  const open = revolutSource.indexOf('{', markerAt);
  let depth = 0;
  let close = -1;
  for (let i = open; i < revolutSource.length; i += 1) {
    if (revolutSource[i] === '{') depth += 1;
    if (revolutSource[i] === '}') {
      depth -= 1;
      if (depth === 0) { close = i; break; }
    }
  }
  assert.ok(close > open, `/${methodPath} route closing brace not found`);

  // Remove local TypeScript-only annotations so the production branch can run
  // unchanged in Node's test VM. No business expression is rewritten.
  const body = revolutSource.slice(open + 1, close)
    .replace('let payload: { reason?: string } = {};', 'let payload = {};')
    .replace(/const p = row as \{[^}]+\} \| null;/, 'const p = row;')
    .replace('let profile = row as JsonRecord | null;', 'let profile = row;')
    .replace('const patch: JsonRecord = {', 'const patch = {')
    .replace(/ as \{[^}]*\} \| null;/g, ';');
  return new AsyncFunction('req', 'path', 'db', 'json', 'logCancelFeedback', 'guardInternalBilling', body);
}

const cancelRoute = extractRoute('cancel');
const resumeRoute = extractRoute('resume');
const profileRoute = extractRoute('profile', 'GET');

function harness(options = {}) {
  const userId = options.userId || 'user-1';
  const calls = { reads: [], feedback: [], rpc: [] };

  const db = {
    auth: {
      getUser: async () => ({ data: { user: options.signedOut ? null : { id: userId } } }),
    },
    from(table) {
      const query = {
        select() { return query; },
        eq(column, value) {
          calls.reads.push({ table, column, value });
          return query;
        },
        maybeSingle: async () => ({ data: options.row || null, error: null }),
      };
      return query;
    },
    async rpc(name, args) {
      calls.rpc.push({ name, args });
      return {
        data: Object.prototype.hasOwnProperty.call(options, 'rpcData')
          ? options.rpcData
          : [{ status: options.rpcStatus || 'cancelled_at_period_end', access_until: options.accessUntil ?? null, applied: true }],
        error: options.rpcError || null,
      };
    },
  };

  const req = {
    method: 'POST',
    headers: { get: (name) => name.toLowerCase() === 'authorization' ? 'Bearer test-jwt' : '' },
    json: async () => ({ reason: options.reason || 'too_expensive' }),
  };
  const json = (body, status = 200) => ({ body, status });
  const logCancelFeedback = async (...args) => { calls.feedback.push(args); };
  const guardInternalBilling = async (_db, _userId, neutralIncludedProfile = false) => {
    if (options.internalLookupError) {
      return json({ error: 'Could not verify billing eligibility', code: 'billing_eligibility_unavailable' }, 503);
    }
    if (options.internal) {
      if (neutralIncludedProfile) {
        return json({ ok: true, profile: null, included_access: true });
      }
      return json({
        error: 'Billing is not applicable to this included-access account',
        code: 'internal_account_not_billable',
      }, 409);
    }
    return null;
  };

  return { db, req, json, logCancelFeedback, guardInternalBilling, calls };
}

async function run(route, routePath, options) {
  const h = harness(options);
  const result = await route(
    h.req, routePath, h.db, h.json, h.logCancelFeedback, h.guardInternalBilling,
  );
  return { ...h, result };
}

test('/cancel and /resume fail closed for internal accounts before the atomic RPC', async () => {
  for (const route of [cancelRoute, resumeRoute]) {
    const internal = await run(route, 'ignored', {
      internal: true,
      row: { status: 'active', provider: 'revolut' },
    });
    assert.equal(internal.result.status, 409);
    assert.equal(internal.result.body.code, 'internal_account_not_billable');
    assert.equal(internal.calls.rpc.length, 0);
    assert.equal(internal.calls.feedback.length, 0);

    const unknown = await run(route, 'ignored', {
      internalLookupError: true,
      row: { status: 'active', provider: 'revolut' },
    });
    assert.equal(unknown.result.status, 503);
    assert.equal(unknown.result.body.code, 'billing_eligibility_unavailable');
    assert.equal(unknown.calls.rpc.length, 0);
    assert.equal(unknown.calls.feedback.length, 0);
  }
});

test('/profile returns neutral included access for internal accounts and fails closed on lookup error', async () => {
  const internal = await run(profileRoute, '/profile', { internal: true });
  assert.deepEqual(internal.result, {
    status: 200,
    body: { ok: true, profile: null, included_access: true },
  });
  assert.equal(internal.calls.rpc.length, 0);

  const unknown = await run(profileRoute, '/profile', { internalLookupError: true });
  assert.equal(unknown.result.status, 503);
  assert.equal(unknown.result.body.code, 'billing_eligibility_unavailable');
  assert.equal(unknown.calls.rpc.length, 0);
});

test('/cancel maps authoritative non-Revolut and non-cancellable RPC outcomes', async () => {
  for (const message of ['no_revolut_subscription', 'nothing_to_cancel']) {
    const { result, calls } = await run(cancelRoute, '/cancel', { rpcError: { message } });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'No cancellable Norva plan on this account');
    assert.equal(calls.rpc.length, 1);
    assert.equal(calls.rpc[0].args.p_action, 'cancel');
    assert.equal(calls.feedback.length, 0);
  }
});

test('/cancel delegates projection mutation and event journaling to one atomic RPC', async () => {
  const trialEnd = new Date(Date.now() + 5 * 86400000).toISOString();
  const { result, calls } = await run(cancelRoute, '/cancel', {
    rpcData: [{ status: 'cancelled_at_period_end', access_until: trialEnd, applied: true }],
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    ok: true, status: 'cancelled_at_period_end', access_until: trialEnd,
  });
  assert.equal(calls.rpc.length, 1);
  assert.equal(calls.rpc[0].name, 'norva_apply_revolut_account_action');
  assert.equal(calls.rpc[0].args.p_user_id, 'user-1');
  assert.equal(calls.rpc[0].args.p_action, 'cancel');
  assert.equal(
    calls.rpc[0].args.p_event_id,
    `account:cancel:user-1:${calls.rpc[0].args.p_event_at}`,
  );
  assert.ok(Number.isFinite(Date.parse(calls.rpc[0].args.p_event_at)));
  assert.equal(calls.feedback.length, 1);
  assert.deepEqual(calls.feedback[0].slice(1), [
    'user-1', 'too_expensive', 'cancelled', 'cancelled_at_period_end',
  ]);
});

test('/cancel preserves the authoritative access boundary returned by SQL', async () => {
  const periodEnd = new Date(Date.now() + 20 * 86400000).toISOString();
  const { result, calls } = await run(cancelRoute, '/cancel', {
    rpcData: [{ status: 'cancelled_at_period_end', access_until: periodEnd, applied: true }],
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.access_until, periodEnd);
  assert.equal(calls.rpc.length, 1);
});

test('/cancel exposes immediate expiry returned by the atomic action', async () => {
  const { result, calls } = await run(cancelRoute, '/cancel', {
    rpcData: [{ status: 'expired', access_until: null, applied: true }],
  });
  assert.deepEqual(result, { status: 200, body: { ok: true, status: 'expired', access_until: null } });
  assert.equal(calls.rpc.length, 1);
});

test('/cancel is idempotent once already cancelled', async () => {
  const periodEnd = new Date(Date.now() + 3 * 86400000).toISOString();
  const { result, calls } = await run(cancelRoute, '/cancel', {
    rpcData: [{ status: 'cancelled_at_period_end', access_until: periodEnd, applied: false }],
  });
  assert.deepEqual(result, {
    status: 200,
    body: { ok: true, status: 'cancelled_at_period_end', access_until: periodEnd },
  });
  assert.equal(calls.rpc.length, 1);
  assert.equal(calls.feedback.length, 0);
});

test('/cancel reports database errors and zero-row races separately', async () => {
  const failed = await run(cancelRoute, '/cancel', {
    rpcError: { message: 'database unavailable' },
  });
  assert.equal(failed.result.status, 503);
  assert.equal(failed.result.body.error, 'Could not cancel the plan');

  const missing = await run(cancelRoute, '/cancel', { rpcData: [] });
  assert.equal(missing.result.status, 503);
  assert.equal(missing.calls.feedback.length, 0);
});

test('/resume maps authoritative wrong-state and expired-period errors', async () => {
  const absent = await run(resumeRoute, '/resume', { rpcError: { message: 'no_pending_cancellation' } });
  assert.equal(absent.result.status, 400);
  assert.equal(absent.result.body.error, 'No pending cancellation to resume');
  const expired = await run(resumeRoute, '/resume', { rpcError: { message: 'subscription_already_ended' } });
  assert.equal(expired.result.status, 400);
  assert.match(expired.result.body.error, /already ended/i);
});

test('/resume returns the atomic SQL status and journals through the same RPC', async () => {
  for (const expected of ['trialing', 'active']) {
    const { result, calls } = await run(resumeRoute, '/resume', {
      rpcData: [{ status: expected, access_until: new Date(Date.now() + 86400000).toISOString(), applied: true }],
    });
    assert.deepEqual(result, { status: 200, body: { ok: true, status: expected } });
    assert.equal(calls.rpc.length, 1);
    assert.equal(calls.rpc[0].name, 'norva_apply_revolut_account_action');
    assert.equal(calls.rpc[0].args.p_user_id, 'user-1');
    assert.equal(calls.rpc[0].args.p_action, 'resume');
    assert.equal(
      calls.rpc[0].args.p_event_id,
      `account:resume:user-1:${calls.rpc[0].args.p_event_at}`,
    );
    assert.ok(Number.isFinite(Date.parse(calls.rpc[0].args.p_event_at)));
  }
});

test('/resume reports database and missing-row failures', async () => {
  const failed = await run(resumeRoute, '/resume', {
    rpcError: { message: 'database unavailable' },
  });
  assert.equal(failed.result.status, 503);
  assert.equal(failed.result.body.error, 'Could not resume the plan');

  const missing = await run(resumeRoute, '/resume', { rpcData: [] });
  assert.equal(missing.result.status, 503);
});

test('build and Cloudflare deployment workflows run npm test before build/deploy work', () => {
  const build = fs.readFileSync(path.join(root, '.github', 'workflows', 'build.yml'), 'utf8');
  const deploy = fs.readFileSync(path.join(root, '.github', 'workflows', 'deploy-cloudflare.yml'), 'utf8');

  const buildTest = build.indexOf('run: npm test');
  assert.ok(buildTest >= 0, 'build.yml must run npm test');
  assert.ok(buildTest < build.indexOf('run: npm run build:desktop'),
    'the regression suite must be declared before build artifact work');
  assert.doesNotMatch(build.slice(build.lastIndexOf('- name: Run regression suite', buildTest), buildTest),
    /continue-on-error:\s*true/);

  const deployTest = deploy.indexOf('run: npm test');
  const deployAction = deploy.indexOf('uses: cloudflare/wrangler-action@');
  const deployCommand = deploy.indexOf('command: pages deploy');
  assert.ok(deployTest >= 0, 'deploy-cloudflare.yml must run npm test');
  assert.ok(deployAction > deployTest && deployCommand > deployTest,
    'Cloudflare deployment must be ordered after npm test');
  assert.doesNotMatch(deploy.slice(deploy.lastIndexOf('- name: Run regression suite', deployTest), deployTest),
    /continue-on-error:\s*true/);
});
