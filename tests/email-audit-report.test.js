const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const artifact = JSON.parse(fs.readFileSync(path.join(
  root,
  'docs/audits/email-resend-2026-07-21/artifact.json',
), 'utf8'));

test('email audit snapshot uses reproducible production column names', () => {
  const serialized = JSON.stringify(artifact);
  assert.match(serialized, /marketing_email_opt_in is true/);
  assert.doesNotMatch(serialized, /where opt_in/);
});

test('email audit exposes concrete provider gaps and every template family', () => {
  const rows = artifact.snapshot.datasets.email_matrix;
  assert.ok(Array.isArray(rows) && rows.length >= 42);
  const serialized = JSON.stringify(rows);
  for (const family of ['Auth', 'Security', 'Catalog', 'Product', 'Trial', 'Dunning',
    'Billing', 'Marketing', 'Support', 'Operations']) {
    assert.ok(rows.some(({ area }) => area === family), `${family} must remain inventoried`);
  }
  assert.match(serialized, /RevenueCat[\s\S]*Gap: outbox rejects non-Revolut ledger rows/);
  assert.match(serialized, /refund, revocation or fraud state[\s\S]*Gap:/);
});

test('email audit documents campaign exclusions, PII windows and QA limits', () => {
  const campaigns = artifact.snapshot.datasets.campaign_guardrails;
  assert.ok(Array.isArray(campaigns) && campaigns.length >= 7);
  for (const row of campaigns) {
    assert.match(row.exclude, /internal-pilots/);
    assert.match(row.exclude, /blocked-suppressed/);
  }
  const serialized = JSON.stringify(artifact);
  assert.match(serialized, /scrubs? that PII after 90 days/i);
  assert.match(serialized, /English-only/);
  assert.match(serialized, /structural only/i);
  assert.match(serialized, /False permanent-bounce recovery/);
});
