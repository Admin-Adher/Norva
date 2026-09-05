const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { importTypescriptModule } = require('./helpers/import-typescript-module');
const root = path.resolve(__dirname, '..');

test('terminal provider HTTP statuses require action, not an automatic retry promise', async () => {
  const { isTerminalSourceSyncStatus } = await import(pathToFileURL(path.join(root, 'supabase/functions/_shared/source-sync-error.mjs')).href);
  for (const status of [400, 401, 403, 404, 410]) assert.equal(isTerminalSourceSyncStatus(status), true);
  for (const status of [408, 425, 429, 500, 503]) assert.equal(isTerminalSourceSyncStatus(status), false);
  const producer = fs.readFileSync(path.join(root, 'supabase/functions/_shared/xtream-sync.ts'), 'utf8');
  assert.match(producer, /failureDisposition: terminal \? "action_required" : "unknown"/);
});

test('terminal and legacy failure emails do not promise unconfirmed retries', async () => {
  const { renderImportFailed } = await importTypescriptModule(path.join(root, 'supabase/functions/_shared/import-email.ts'));
  for (const providers of [
    [{ name: 'Provider', failureDisposition: 'action_required' }],
    [{ name: 'Provider', failureDisposition: 'unknown' }],
    [{ name: 'Legacy provider' }],
    [{ name: 'A', failureDisposition: 'unknown' }, { name: '<B>', failureDisposition: 'action_required' }],
  ]) {
    const result = renderImportFailed(null, providers);
    for (const body of [result.text, result.html]) {
      assert.doesNotMatch(body, /We retry automatically|Norva retries automatically|no action is needed|nothing you need to do/i);
      assert.match(body, /M3U/);
      assert.match(body, /Xtream/);
      assert.match(body, /Never email us your password/);
      assert.match(body, /https:\/\/norva.tv\/app.html/);
      if (providers.some(p => p.failureDisposition === 'action_required')) assert.match(body, /import has stopped/);
      else assert.match(body, /cannot confirm that an automatic retry is scheduled/);
    }
    assert.doesNotMatch(result.html, /<B>/);
  }
});

test('failure disposition comes from claimed events and is bounded; delivery freezing remains in place', () => {
  const notify = fs.readFileSync(path.join(root, 'supabase/functions/norva-import-notify/index.ts'), 'utf8');
  assert.match(notify, /failure_disposition:payload->>failureDisposition/);
  assert.match(notify, /\.in\("id", claim.notification_ids\)\.eq\("user_id", userId\)/);
  assert.match(notify, /failure.failure_disposition === "action_required" \? "action_required" : "unknown"/);
  assert.match(notify, /prepare_import_notification_delivery/);
  assert.doesNotMatch(notify, /We're on it/);
});
