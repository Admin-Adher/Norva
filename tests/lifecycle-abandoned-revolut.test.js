const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('abandoned checkout lifecycle uses Revolut claim and no retired Stancer tables', () => {
  const source = fs.readFileSync(path.join(root, 'supabase/functions/norva-lifecycle/index.ts'), 'utf8');
  const abandoned = source.slice(source.indexOf('async function runAbandoned'), source.indexOf('async function runExpirePastDue'));
  assert.match(abandoned, /claim_revolut_abandoned_orders/);
  assert.match(abandoned, /reminder_claimed_at/);
  assert.match(abandoned, /idempotencyKey/);
  assert.match(abandoned, /await release\(\)/);
  assert.doesNotMatch(abandoned, /stancer/i);
});

test('abandoned email targets a real public page and the USD validation amount', () => {
  const template = fs.readFileSync(path.join(root, 'supabase/functions/_shared/lifecycle-email.ts'), 'utf8');
  assert.match(template, /checkout-revolut\.html\?plan=/);
  assert.match(template, /\$0\.50/);
  assert.equal(fs.existsSync(path.join(root, 'public/checkout-revolut.html')), true);
  assert.doesNotMatch(template, /checkout\.html\?plan=/);
  assert.doesNotMatch(template, /€0\.50/);
});

test('Revolut webhook synchronizes and finalizes the local order journal', () => {
  const source = fs.readFileSync(path.join(root, 'supabase/functions/norva-revolut-webhook/index.ts'), 'utf8');
  assert.match(source, /last_reconciled_at/);
  assert.match(source, /ORDER_AUTHORISED/);
  assert.match(source, /finalizeCheckoutEntitlement/);
  assert.match(source, /finalization_result/);
});
