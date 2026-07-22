const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(
  root,
  'supabase/migrations/20260722122000_truthful_trial_reminders.sql',
), 'utf8');

test('the latest trial reminder overrides the old contradictory renewal copy', () => {
  assert.match(migration, /create or replace function public\.norva_send_trial_ending_reminders/);
  assert.match(migration, /Unless you cancel before then[\s\S]{0,180}start automatically/);
  assert.match(migration, /renew until cancelled/);
  assert.doesNotMatch(migration, /never charged automatically/i);
});

test('trial reminders contain account-specific date, price, cadence and self-service management', () => {
  assert.match(migration, /e\.trial_ends_at/);
  assert.match(migration, /e\.mrr_cents/);
  assert.match(migration, /e\.bill_period/);
  assert.match(migration, /e\.billing_currency/);
  assert.match(migration, /https:\/\/norva\.tv\/subscription\.html/);
  assert.match(migration, /admin_internal_accounts/);
});
