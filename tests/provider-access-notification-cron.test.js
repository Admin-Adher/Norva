const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const migration = fs.readFileSync(path.join(
  __dirname,
  '..',
  'supabase',
  'migrations',
  '20260825001459_provider_access_notification_cron_v1.sql',
), 'utf8');

test('notification cron migration is dormant and exposes only explicit lifecycle RPCs', () => {
  assert.match(migration, /create or replace function public\.norva_install_provider_access_notification_cron\(\)/);
  assert.match(migration, /create or replace function public\.norva_remove_provider_access_crons\(\)/);
  assert.doesNotMatch(migration, /select\s+public\.norva_install_provider_access_notification_cron\(\)\s*;/);
});

test('notification cron install requires rollout, cache, P0, capability and secret', () => {
  assert.match(migration, /provider_access_notifications_v1_enabled/);
  assert.match(migration, /reason=feature_disabled/);
  assert.match(migration, /cache\.phase = 'complete'/);
  assert.match(migration, /norva_assert_provider_access_rollout_safe/);
  assert.match(migration, /norva_cron_shared_secret/);
  assert.match(migration, /stage <> 'off'/);
});

test('scheduled network call rechecks OFF on every tick and has bounded timeout', () => {
  assert.match(migration, /where coalesce\(public\.feature_flag\('provider_access_notifications_v1_enabled'\),false\)/);
  assert.match(migration, /timeout_milliseconds := 180000/);
  assert.match(migration, /norva-provider-access-notify\/cron\/drain/);
});

test('emergency removal is bounded to the two Provider Access cron names', () => {
  assert.match(migration, /'norva-provider-access-notifications'/);
  assert.match(migration, /'norva-provider-access-checks'/);
  assert.match(migration, /where jobname in/);
  assert.doesNotMatch(migration, /delete\s+from\s+cron\.job/i);
});
