const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');

test('Revolut order money uses the observed nested response and rejects disagreement', async () => {
  const { revolutOrderMoney } = await import(pathToFileURL(path.join(root, 'supabase/functions/_shared/revolut-order-money.mjs')).href);
  assert.deepEqual(revolutOrderMoney({ order_amount: { value: 50, currency: 'USD' } }), { amountCents: 50, currency: 'USD' });
  assert.deepEqual(revolutOrderMoney({ amount: 50, currency: 'USD' }), { amountCents: 50, currency: 'USD' });
  assert.deepEqual(revolutOrderMoney({ amount: 50, currency: 'USD', order_amount: { value: 50, currency: 'USD' } }), { amountCents: 50, currency: 'USD' });
  assert.deepEqual(revolutOrderMoney({ amount: 499, currency: 'USD', order_amount: { value: 50, currency: 'USD' } }), { amountCents: null, currency: null });
  assert.deepEqual(revolutOrderMoney({ order_amount: { value: 50, currency: 'EUR' } }), { amountCents: 50, currency: 'EUR' });
  assert.deepEqual(revolutOrderMoney({ metadata: { amount_cents: '499', price_currency: 'USD' } }), { amountCents: null, currency: null });
});

test('both checkout and webhook verify provider money through the shared reader', () => {
  for (const file of ['norva-revolut/index.ts', 'norva-revolut-webhook/index.ts']) {
    const source = fs.readFileSync(path.join(root, 'supabase/functions', file), 'utf8');
    assert.match(source, /revolutOrderMoney\(order\)/);
    assert.doesNotMatch(source, /Number\(order\.amount\)|String\(order\.currency/);
  }
});
