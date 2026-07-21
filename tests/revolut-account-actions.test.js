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

  // Remove the two local TypeScript annotations so the production branch can
  // run unchanged in Node's test VM. No business expression is rewritten.
  const body = revolutSource.slice(open + 1, close)
    .replace('let payload: { reason?: string } = {};', 'let payload = {};')
    .replace(/const p = row as \{[^}]+\} \| null;/, 'const p = row;')
    .replace('let profile = row as JsonRecord | null;', 'let profile = row;')
    .replace('const patch: JsonRecord = {', 'const patch = {');
  return new AsyncFunction('req', 'path', 'db', 'json', 'logCancelFeedback', 'guardInternalBilling', body);
}

const cancelRoute = extractRoute('cancel');
const resumeRoute = extractRoute('resume');
const profileRoute = extractRoute('profile', 'GET');

function harness(options = {}) {
  const userId = options.userId || 'user-1';
  const calls = { updates: [], eqs: [], feedback: [] };
  const updateData = Object.prototype.hasOwnProperty.call(options, 'updateData')
    ? options.updateData
    : [{ user_id: userId }];
  const updateError = options.updateError || null;
  let querySequence = 0;

  const db = {
    auth: {
      getUser: async () => ({ data: { user: options.signedOut ? null : { id: userId } } }),
    },
    from(table) {
      const queryId = ++querySequence;
      let mode = 'read';
      const query = {
        select() { return query; },
        eq(column, value) {
          calls.eqs.push({ table, queryId, mode, column, value });
          return query;
        },
        maybeSingle: async () => ({ data: options.row || null, error: null }),
        update(patch) {
          mode = 'update';
          calls.updates.push({ table, queryId, patch });
          return query;
        },
        then(resolve, reject) {
          return Promise.resolve({ data: updateData, error: updateError }).then(resolve, reject);
        },
      };
      return query;
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

function updateCas(calls) {
  const update = calls.updates[0];
  assert.ok(update, 'projection update was not issued');
  return Object.fromEntries(calls.eqs
    .filter((entry) => entry.queryId === update.queryId && entry.mode === 'update')
    .map((entry) => [entry.column, entry.value]));
}

async function run(route, routePath, options) {
  const h = harness(options);
  const result = await route(
    h.req, routePath, h.db, h.json, h.logCancelFeedback, h.guardInternalBilling,
  );
  return { ...h, result };
}

test('/cancel and /resume fail closed for internal accounts before any projection write', async () => {
  for (const route of [cancelRoute, resumeRoute]) {
    const internal = await run(route, 'ignored', {
      internal: true,
      row: { status: 'active', provider: 'revolut' },
    });
    assert.equal(internal.result.status, 409);
    assert.equal(internal.result.body.code, 'internal_account_not_billable');
    assert.equal(internal.calls.updates.length, 0);

    const unknown = await run(route, 'ignored', {
      internalLookupError: true,
      row: { status: 'active', provider: 'revolut' },
    });
    assert.equal(unknown.result.status, 503);
    assert.equal(unknown.result.body.code, 'billing_eligibility_unavailable');
    assert.equal(unknown.calls.updates.length, 0);
  }
});

test('/profile returns neutral included access for internal accounts and fails closed on lookup error', async () => {
  const internal = await run(profileRoute, '/profile', { internal: true });
  assert.deepEqual(internal.result, {
    status: 200,
    body: { ok: true, profile: null, included_access: true },
  });
  assert.equal(internal.calls.updates.length, 0);

  const unknown = await run(profileRoute, '/profile', { internalLookupError: true });
  assert.equal(unknown.result.status, 503);
  assert.equal(unknown.result.body.code, 'billing_eligibility_unavailable');
  assert.equal(unknown.calls.updates.length, 0);
});

test('/cancel rejects a missing or non-Revolut projection without writing', async () => {
  for (const row of [null, { status: 'active', provider: 'google_play' }]) {
    const { result, calls } = await run(cancelRoute, '/cancel', { row });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'No cancellable Norva plan on this account');
    assert.equal(calls.updates.length, 0);
  }
});

test('/cancel trialing preserves trial access and uses provider/status CAS', async () => {
  const trialEnd = new Date(Date.now() + 5 * 86400000).toISOString();
  const { result, calls } = await run(cancelRoute, '/cancel', {
    row: { status: 'trialing', provider: 'revolut', trial_ends_at: trialEnd },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    ok: true, status: 'cancelled_at_period_end', access_until: trialEnd,
  });
  assert.equal(calls.updates[0].patch.status, 'cancelled_at_period_end');
  assert.equal(calls.updates[0].patch.current_period_end, trialEnd);
  assert.deepEqual(updateCas(calls), {
    user_id: 'user-1', provider: 'revolut', status: 'trialing',
  });
  assert.equal(calls.feedback.length, 1);
});

test('/cancel active preserves current period and uses provider/status CAS', async () => {
  const periodEnd = new Date(Date.now() + 20 * 86400000).toISOString();
  const { result, calls } = await run(cancelRoute, '/cancel', {
    row: { status: 'active', provider: 'revolut', current_period_end: periodEnd },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.access_until, periodEnd);
  assert.equal(calls.updates[0].patch.status, 'cancelled_at_period_end');
  assert.equal(Object.hasOwn(calls.updates[0].patch, 'current_period_end'), false);
  assert.deepEqual(updateCas(calls), {
    user_id: 'user-1', provider: 'revolut', status: 'active',
  });
});

test('/cancel expires past_due and grace immediately with exact-status CAS', async () => {
  for (const status of ['past_due', 'grace']) {
    const { result, calls } = await run(cancelRoute, '/cancel', {
      row: { status, provider: 'revolut' },
    });
    assert.deepEqual(result, { status: 200, body: { ok: true, status: 'expired' } });
    assert.equal(calls.updates[0].patch.status, 'expired');
    assert.deepEqual(updateCas(calls), {
      user_id: 'user-1', provider: 'revolut', status,
    });
  }
});

test('/cancel is idempotent once already cancelled', async () => {
  const periodEnd = new Date(Date.now() + 3 * 86400000).toISOString();
  const { result, calls } = await run(cancelRoute, '/cancel', {
    row: { status: 'cancelled_at_period_end', provider: 'revolut', current_period_end: periodEnd },
  });
  assert.deepEqual(result, {
    status: 200,
    body: { ok: true, status: 'cancelled_at_period_end', access_until: periodEnd },
  });
  assert.equal(calls.updates.length, 0);
  assert.equal(calls.feedback.length, 0);
});

test('/cancel reports database errors and zero-row races separately', async () => {
  const row = { status: 'active', provider: 'revolut' };
  const failed = await run(cancelRoute, '/cancel', {
    row, updateError: { message: 'database unavailable' },
  });
  assert.equal(failed.result.status, 503);
  assert.equal(failed.result.body.error, 'Could not cancel the plan');

  const raced = await run(cancelRoute, '/cancel', { row, updateData: [] });
  assert.equal(raced.result.status, 409);
  assert.match(raced.result.body.error, /changed concurrently/i);
  assert.equal(raced.calls.feedback.length, 0);
});

test('/resume rejects wrong state/provider and an already expired period', async () => {
  for (const row of [
    { status: 'active', provider: 'revolut' },
    { status: 'cancelled_at_period_end', provider: 'google_play' },
  ]) {
    const { result, calls } = await run(resumeRoute, '/resume', { row });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'No pending cancellation to resume');
    assert.equal(calls.updates.length, 0);
  }

  const expired = await run(resumeRoute, '/resume', {
    row: {
      status: 'cancelled_at_period_end', provider: 'revolut',
      current_period_end: new Date(Date.now() - 1000).toISOString(),
    },
  });
  assert.equal(expired.result.status, 400);
  assert.match(expired.result.body.error, /already ended/i);
  assert.equal(expired.calls.updates.length, 0);
});

test('/resume returns to trialing or active and CAS-locks the original end date', async () => {
  const periodEnd = new Date(Date.now() + 7 * 86400000).toISOString();
  for (const [trialEnd, expected] of [
    [new Date(Date.now() + 2 * 86400000).toISOString(), 'trialing'],
    [new Date(Date.now() - 2 * 86400000).toISOString(), 'active'],
  ]) {
    const { result, calls } = await run(resumeRoute, '/resume', {
      row: {
        status: 'cancelled_at_period_end', provider: 'revolut',
        current_period_end: periodEnd, trial_ends_at: trialEnd,
      },
    });
    assert.deepEqual(result, { status: 200, body: { ok: true, status: expected } });
    assert.equal(calls.updates[0].patch.status, expected);
    assert.deepEqual(updateCas(calls), {
      user_id: 'user-1', provider: 'revolut',
      status: 'cancelled_at_period_end', current_period_end: periodEnd,
    });
  }
});

test('/resume reports database errors and zero-row races separately', async () => {
  const row = {
    status: 'cancelled_at_period_end', provider: 'revolut',
    current_period_end: new Date(Date.now() + 86400000).toISOString(),
  };
  const failed = await run(resumeRoute, '/resume', {
    row, updateError: { message: 'database unavailable' },
  });
  assert.equal(failed.result.status, 503);
  assert.equal(failed.result.body.error, 'Could not resume the plan');

  const raced = await run(resumeRoute, '/resume', { row, updateData: [] });
  assert.equal(raced.result.status, 409);
  assert.match(raced.result.body.error, /changed concurrently/i);
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
