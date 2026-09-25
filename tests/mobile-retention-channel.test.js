const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { transformSync } = require('esbuild');

const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-lifecycle/index.ts'), 'utf8');
const start = source.indexOf('async function runWinback(');
const end = source.indexOf('// Checkout-abandonment', start);
const code = transformSync(source.slice(start, end), { loader: 'ts', target: 'node18' }).code;

async function run(rows, policy, consent = true) {
  const sent = [], filters = [];
  const query = {
    select() { return this; }, eq(k, v) { filters.push([k, v]); return this; },
    in() { return this; }, is() { return this; }, gte() { return this; }, lte() { return this; },
    limit() { return { data: rows }; }, maybeSingle() { return policy; },
  };
  const db = { from() { return query; } };
  const fn = new Function('BATCH', 'marketingEmailAllowed', 'queueUserEmail', 'renderWinback',
    `${code}\nreturn runWinback;`)(100, async () => consent,
    async (_db, user, render, options) => {
      sent.push({ user, rendered: render(null, { unsubscribeUrl: 'https://fixture.test/optout' }), options });
      return { created: true };
    }, () => ({ text: 'web checkout' }));
  return { count: await fn(db), sent, filters };
}

test('legacy web winback excludes every store and unknown payment channel', async () => {
  const rows = ['revolut', 'google_play', 'apple_app_store', 'revenuecat', 'system', null]
    .map((provider, i) => ({ provider, user_id: `fixture-${i}` }));
  const result = await run(rows, { data: { enabled: false } });
  assert.equal(result.count, 1);
  assert.deepEqual(result.sent.map(x => x.user), ['fixture-0']);
  assert.ok(result.filters.some(([k, v]) => k === 'provider' && v === 'revolut'));
});

test('personal web offers own follow-ups; missing policy fails closed', async () => {
  for (const policy of [{ data: { enabled: true } }, { data: null }, { error: {} }]) {
    assert.equal((await run([{ provider: 'revolut', user_id: 'fixture' }], policy)).count, 0);
  }
});

test('legacy marketing still requires consent and preserves deduplication', async () => {
  const rows = [{ provider: 'revolut', user_id: 'fixture' }];
  assert.equal((await run(rows, { data: { enabled: false } }, false)).count, 0);
  const { sent } = await run(rows, { data: { enabled: false } });
  assert.equal(sent[0].options.marketing, true);
  assert.equal(sent[0].options.markerKind, 'winback');
  assert.equal(sent[0].options.dedupeKey, 'lifecycle:winback:fixture');
});
