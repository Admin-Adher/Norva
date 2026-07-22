const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { importTypescriptModule } = require('./helpers/import-typescript-module');

const root = path.resolve(__dirname, '..');
const importTemplatePath = path.join(root, 'supabase/functions/_shared/import-email.ts');
const lifecycleTemplatePath = path.join(root, 'supabase/functions/_shared/lifecycle-email.ts');

function assertPremiumEnvelope(rendered, expectedCategory, expectedFlow) {
  assert.ok(rendered.subject.length > 8);
  assert.match(rendered.html, /<!doctype html>/i);
  assert.match(rendered.html, /<html lang="en" dir="ltr">/i);
  assert.match(rendered.html, /data-preheader="true"/i);
  assert.match(rendered.html, /<h1\b/i);
  assert.match(rendered.html, /role="presentation"/i);
  assert.match(rendered.html, /x-apple-disable-message-reformatting/i);
  assert.match(rendered.html, /color:#bcc5d6/i);
  assert.doesNotMatch(rendered.html, /display\s*:\s*(?:flex|grid)/i);
  assert.equal(typeof rendered.text, 'string');
  assert.ok(rendered.text.length > 60);
  assert.doesNotMatch(rendered.text, /<\/?(?:html|table|tr|td|p|a)\b/i);
  assert.deepEqual(rendered.tags, [
    { name: 'app', value: 'norva' },
    { name: 'category', value: expectedCategory },
    { name: 'flow', value: expectedFlow },
  ]);
  for (const tag of rendered.tags) {
    assert.match(tag.name, /^[a-z_]+$/);
    assert.match(tag.value, /^[a-z_]+$/);
  }
}

test('catalog import emails have client-safe HTML, coherent plain text and stable non-PII tags', async () => {
  const templates = await importTypescriptModule(importTemplatePath);
  const providers = [{ name: 'Atlas Pro', movies: 1234, series: 56, channels: 78 }];
  const cases = [
    [templates.renderImportStarted('Adrien', providers), 'import_started'],
    [templates.renderImportCompleted('Adrien', providers), 'import_completed'],
    [templates.renderImportFailed('Adrien', providers), 'import_failed'],
  ];

  for (const [rendered, flow] of cases) {
    assertPremiumEnvelope(rendered, 'transactional', flow);
    assert.match(rendered.text, /Atlas Pro/);
    assert.ok(!rendered.tags.some(({ value }) => /adrien|atlas/i.test(value)));
  }
  assert.match(cases[1][0].text, /Open Norva: https:\/\/norva\.tv\/app\.html/);
  assert.match(cases[2][0].text, /support@norva\.tv/);
});

test('plain-text alternative is derived from the exact frozen import HTML', async () => {
  const templates = await importTypescriptModule(importTemplatePath);
  const rendered = templates.renderImportCompleted(null, [{ name: 'Atlas Pro', movies: 42 }]);
  const text = templates.plainTextFromImportHtml(rendered.html);
  assert.match(text, /Your catalog is ready/);
  assert.match(text, /Open Norva \(https:\/\/norva\.tv\/app\.html\)/);
  assert.match(text, /Atlas Pro/);
  assert.doesNotMatch(text, /Norva catalogs are ready to watch/); // hidden preheader is not duplicated
  assert.doesNotMatch(text, /<[^>]+>/);
});

test('lifecycle templates expose complete multipart content and correct categories', async () => {
  globalThis.Deno = { env: { get: (key) => key === 'NORVA_POSTAL_ADDRESS' ? '1 Premium Way, Paris' : '' } };
  const templates = await importTypescriptModule(lifecycleTemplatePath);
  const unsubscribeUrl = 'https://norva.tv/functions/v1/norva-lifecycle/unsubscribe?token=test';
  const cases = [
    [templates.renderWelcome('Adrien'), 'transactional', 'welcome'],
    [templates.renderTrialEnding('Adrien', { endsAt: '2026-07-23T00:00:00Z', planLabel: 'Norva Family' }), 'transactional', 'trial_ending'],
    [templates.renderReceipt('Adrien', {
      planLabel: 'Norva Family',
      amount: '$9.99',
      currency: 'USD',
      billingPeriod: 'annual',
      confirmedAt: '2026-07-21T12:00:00Z',
      periodEnd: '2027-07-21T12:00:00Z',
      reference: 'NV-A1B2C3D4E5F6',
    }), 'transactional', 'payment_receipt'],
    [templates.renderPaymentFailed('Adrien', 3), 'transactional', 'payment_failed'],
    [templates.renderWinback('Adrien', { unsubscribeUrl }), 'marketing', 'winback'],
    [templates.renderAbandonedCheckout('Adrien', { plan: 'family', period: 'annual', unsubscribeUrl }), 'marketing', 'checkout_abandoned'],
  ];

  for (const [rendered, category, flow] of cases) {
    assertPremiumEnvelope(rendered, category, flow);
    assert.ok(!rendered.tags.some(({ value }) => /adrien|@|token/i.test(value)));
  }
  for (const [rendered, category] of cases) {
    if (category === 'marketing') {
      assert.match(rendered.html, /Unsubscribe/);
      assert.match(rendered.text, /Unsubscribe: https:\/\//);
      assert.match(rendered.text, /1 Premium Way, Paris/);
    } else {
      assert.doesNotMatch(rendered.html, />Unsubscribe</);
      assert.doesNotMatch(rendered.text, /^Unsubscribe:/m);
    }
  }
});

test('payment confirmation is precise without pretending to be a legal receipt or invoice', async () => {
  globalThis.Deno = { env: { get: () => '' } };
  const templates = await importTypescriptModule(lifecycleTemplatePath);
  const rendered = templates.renderReceipt('Adrien', {
    planLabel: 'Norva Family',
    amount: '$9.99',
    currency: 'USD',
    billingPeriod: 'annual',
    confirmedAt: '2026-07-21T12:00:00Z',
    periodEnd: '2027-07-21T12:00:00Z',
    reference: 'NV-A1B2C3D4E5F6',
  });

  assert.equal(rendered.subject, 'Your Norva payment is confirmed');
  for (const value of ['Payment date: 21 July 2026', 'Plan: Norva Family', 'Billing cycle: Annual',
    'Amount paid: $9.99 USD', 'Access through: 21 July 2027',
    'Confirmation reference: NV-A1B2C3D4E5F6']) {
    assert.match(rendered.text, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(`${rendered.subject}\n${rendered.text}\n${rendered.html}`, /\b(receipt|invoice|VAT)\b/i);
});

test('Resend senders include multipart text, reply-to and stable tags without weakening delivery guards', () => {
  const imports = fs.readFileSync(path.join(root, 'supabase/functions/norva-import-notify/index.ts'), 'utf8');
  const lifecycle = fs.readFileSync(path.join(root, 'supabase/functions/norva-lifecycle/index.ts'), 'utf8');
  const lifecycleWorker = fs.readFileSync(path.join(root, 'supabase/functions/norva-branded-email-worker/index.ts'), 'utf8');

  assert.match(imports, /"Idempotency-Key": `norva-import-\$\{deliveryKey\}`/);
  assert.match(imports, /reply_to: REPLY_TO/);
  assert.match(imports, /text: prepared\.request_text/);
  assert.match(imports, /tags: prepared\.request_tags/);
  assert.match(imports, /prepare_import_notification_delivery/);
  assert.match(imports, /p_request_html: rendered\.html/);
  assert.match(imports, /p_request_text: plainTextFromImportHtml\(rendered\.html\)/);
  assert.match(imports, /p_request_reply_to: REPLY_TO/);
  assert.match(imports, /p_request_tags: importEmailTags\(claim\.kind\)/);

  assert.match(lifecycle, /p_request_reply_to: REPLY_TO/);
  assert.match(lifecycle, /p_request_text: rendered\.text/);
  assert.match(lifecycle, /p_request_tags: rendered\.tags/);
  assert.match(lifecycle, /p_request_headers: unsubscribeHeaders/);
  assert.match(lifecycle, /norva_enqueue_lifecycle_email/);
  assert.doesNotMatch(lifecycle, /api\.resend\.com\/emails/);
  assert.match(lifecycleWorker, /"Idempotency-Key": claim\.delivery_key/);
  assert.match(lifecycleWorker, /reply_to: claim\.request_reply_to/);
  assert.match(lifecycleWorker, /headers: claim\.request_headers/);
});

test('every remaining direct Resend API caller declares an explicit product User-Agent', () => {
  const functionRoot = path.join(root, 'supabase/functions');
  const senders = fs.readdirSync(functionRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(functionRoot, entry.name, 'index.ts')))
    .map((entry) => `${entry.name}/index.ts`);
  let auditedSenders = 0;
  for (const sender of senders) {
    const source = fs.readFileSync(path.join(functionRoot, sender), 'utf8');
    if (!/https:\/\/api\.resend\.com\/emails(?:\/batch)?/.test(source)) continue;
    auditedSenders++;
    const agents = source.match(/"User-Agent":\s*"Norva-[A-Za-z-]+\/2\.0"/g) ?? [];
    assert.ok(agents.length > 0, `${sender} must identify every direct Resend request`);
  }
  assert.ok(auditedSenders > 0, 'the direct Resend sender inventory must not be empty');
});
