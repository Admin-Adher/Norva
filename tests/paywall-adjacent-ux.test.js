const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

test('a locked profile preserves context and opens the Family remedy directly', () => {
  const profiles = read('public/js/profiles.js');
  const locked = profiles.slice(
    profiles.indexOf('function handleLockedProfile(p)'),
    profiles.indexOf('\n  function selectProfile', profiles.indexOf('function handleLockedProfile(p)')),
  );
  assert.match(locked, /location\.pathname \+ location\.search \+ location\.hash/);
  assert.match(locked, /\/subscribe\.html\?plan=family&context=locked_profile&returnTo=/);
});

test('cancellation feedback is optional, useful, and does not add a blocking step', () => {
  const subscription = read('public/subscription.html');
  const confirm = subscription.slice(
    subscription.indexOf('function simpleConfirm(immediate)'),
    subscription.indexOf("const keep = el('button'", subscription.indexOf('function simpleConfirm(immediate)')),
  );
  assert.match(confirm, /Optional — what is the main reason\?/);
  for (const reason of ['too_expensive', 'not_using', 'technical', 'other']) {
    assert.match(confirm, new RegExp(`\\['${reason}'`));
  }
  assert.match(confirm, /let cancelReason = 'skipped'/);
  assert.match(confirm, /await doCancel\(cancelReason\)/);
  assert.doesNotMatch(confirm, /required\s*=/,
    'answering the cancellation survey must never be required');
});

test('settings do not advertise a non-existent Premium plan', () => {
  const app = read('public/app.html');
  const settings = read('public/js/pages/Settings.js');
  assert.doesNotMatch(app, /data-premium|coming with\s+Premium/i);
  assert.doesNotMatch(settings, /coming with Premium|value === 'premium'/i);
  assert.match(app, /Choose how often Norva checks after you open the app/);
});

test('Android TV keeps one clear external-subscription path', () => {
  const subscription = read('public/subscription.html');
  const billing = read('public/js/billing.js');
  assert.match(subscription, /Subscribe or manage your plan on the web at norva\.tv, or in the Norva phone app/);
  assert.match(subscription, /if \(!isTvShell\(\)\)/);
  assert.match(billing, /if \(isTvShell\(\)\) return false/);
});
