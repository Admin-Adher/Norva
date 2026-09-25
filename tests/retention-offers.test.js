const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { importTypescriptModule } = require('./helpers/import-typescript-module');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'supabase/functions/norva-revolut/index.ts'), 'utf8');
const start = source.indexOf('  if ((req.method === "GET" || req.method === "POST") && path === "/retention-offer") {');
const end = source.indexOf('// ── /profile', start);
assert.ok(start > 0 && end > start);
const route = new (Object.getPrototypeOf(async function () {}).constructor)('req', 'path', 'db', 'json', 'guardInternalBilling', source.slice(start, end));
const offerId = '00000000-0000-4000-8000-000000000001';
async function request(method, payload, options = {}) {
  const calls = [];
  const db = { auth: { getUser: async () => ({ data: { user: options.signedOut ? null : { id: 'authenticated-owner' } } }) },
    rpc: async (name, args) => { calls.push({ name, args }); return { data: options.data ?? { ok: true }, error: options.error }; } };
  const req = new Request('https://fixture.test/retention-offer', { method,
    headers: options.noToken ? {} : { authorization: 'Bearer fixture' },
    ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}) });
  const response = await route(req, '/retention-offer', db, (body, status = 200) => ({ body, status }), async () => options.internal ? { status: 403 } : null);
  return { ...response, calls };
}
test('retention requires authentication and excludes internal billing', async () => {
  for (const options of [{ noToken: true }, { signedOut: true }, { internal: true }]) {
    const r = await request('GET', null, options);
    assert.ok([401, 403].includes(r.status)); assert.equal(r.calls.length, 0);
  }
});
test('GET exposes a quote only, bound to authenticated owner', async () => {
  const r = await request('GET', null, { data: { id: offerId, amount_cents: 399 } });
  assert.equal(r.status, 200); assert.equal(r.body.offer.amount_cents, 399);
  assert.deepEqual(r.calls, [{ name: 'norva_retention_offer', args: { p_user: 'authenticated-owner' } }]);
});
test('explicit acceptance ignores forged owner and client prices', async () => {
  const r = await request('POST', { offer_id: offerId, action: 'accept', user_id: 'victim', amount_cents: 1 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.calls[0], { name: 'norva_retention_action', args: { p_user: 'authenticated-owner', p_offer: offerId, p_action: 'accept' } });
});
test('decline is explicit; invalid and expired offers expose no database errors', async () => {
  assert.equal((await request('POST', { offer_id: offerId, action: 'decline' })).status, 200);
  assert.equal((await request('POST', { offer_id: offerId, action: 'checkout' })).status, 400);
  assert.equal((await request('POST', { offer_id: 'invalid', action: 'accept' })).status, 400);
  const r = await request('POST', { offer_id: offerId, action: 'accept' }, { error: { message: 'sensitive-db-diagnostic' } });
  assert.equal(r.status, 409); assert.doesNotMatch(JSON.stringify(r.body), /sensitive-db/);
});
test('retention emails state prices, duration, payment timing and opt-out', async () => {
  global.Deno = { env: { get: () => 'Synthetic postal address' } };
  const { renderRetentionOffer } = await importTypescriptModule(path.join(root, 'supabase/functions/_shared/retention-email.ts'));
  const offer = { id: offerId, amount_cents: 399, base_amount_cents: 499, cycles: 3, period: 'monthly', stage: 'pre', access_until: '2026-10-01T06:23:00Z', expires_at: '2026-10-08T06:23:00Z' };
  const fr = renderRetentionOffer(offer, { locale: 'fr', unsubscribeUrl: 'https://fixture.test/unsubscribe?t=1&x=2' });
  assert.match(fr.text, /3,99.*3 mois.*4,99/); assert.match(fr.text, /premier paiement réduit/);
  assert.match(fr.html, /unsubscribe\?t=1&amp;x=2/);
  assert.match(fr.text, /reste résilié tant que/);
  const en = renderRetentionOffer({ ...offer, stage: 'post', period: 'annual', cycles: 1, amount_cents: 3779, base_amount_cents: 4199 }, { locale: 'en', unsubscribeUrl: 'https://fixture.test/unsubscribe' });
  assert.match(en.text, /\$37.79.*next year.*\$41.99/);
  assert.match(en.text, /payment will be requested at checkout/);
  assert.doesNotMatch(en.html, /action=accept|mailto:.*example\.test/);
  assert.match(en.html, /https:\/\/norva.tv\/subscription\?retentionOffer=/);
});
