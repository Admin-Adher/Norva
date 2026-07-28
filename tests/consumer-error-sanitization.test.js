'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

const sourceManager = read('public/js/components/SourceManager.js');
const home = read('public/js/pages/HomePage.js');
const account = read('public/account.html');
const support = read('public/support.html');
const deleteAccount = read('public/delete-account.html');
const watchPage = read('public/js/pages/WatchPage.js');

test('source setup never renders provider diagnostics or synchronization payloads', () => {
  assert.doesNotMatch(sourceManager, /statusText[\s\S]{0,180}source\.(?:sync_error|syncError)/);
  assert.doesNotMatch(sourceManager, /NorvaModal\.toast\([^;\n]*(?:err|error)\?*\.message/);
  assert.doesNotMatch(sourceManager, /NorvaModal\.toast\([^;\n]*result\.(?:error|message)/);
  assert.doesNotMatch(home, /error\.textContent\s*=\s*(?:err|error)\?*\.message/);
  assert.match(sourceManager, /sourceFormErrorMessage\(error\)/);
  assert.match(sourceManager, /Norva could not finish importing this service\. Try again\./);
});

test('account errors are classified and sign-out is cancel-first', () => {
  assert.doesNotMatch(account, /setStatus\([^;\n]*(?:err|error|e)\?*\.message/);
  assert.doesNotMatch(account, /error_description'\)\s*\|\|/);
  assert.match(account, /function authErrorMessage\(error\)/);
  assert.match(account, /if \(!await confirmAccountSignOut\(out\)\) return/);
  assert.match(account, /class="account-confirm-cancel secondary">Stay signed in</);
  assert.match(account, /dialog\.addEventListener\('cancel'/);
  assert.match(account, /opener\.focus\(\{ preventScroll: true \}\)/);
});

test('support and account deletion expose bounded recovery copy only', () => {
  assert.doesNotMatch(support, /(?:textContent|innerHTML)\s*=\s*[^;\n]*(?:err|error|e)\?*\.message/);
  assert.doesNotMatch(deleteAccount, /setStatus\([^;\n]*(?:err|error)\?*\.message/);
  assert.match(support, /Could not send your message\. Check your connection and try again\./);
  assert.match(deleteAccount, /Deletion failed\. Check your connection and try again\./);
});

test('consumer payment, pairing and login pages never append raw exception copy', () => {
  const files = [
    'public/checkout-revolut.html',
    'public/cloud.html',
    'public/cloud-pair.html',
    'public/cloud-link.html',
    'public/pair-approve.html',
    'public/login.html',
    'public/js/login.js',
    'public/subscribe.html'
  ];
  const joined = files.map(read).join('\n');
  assert.doesNotMatch(joined, /(?:textContent|innerHTML|setStatus)\s*\([^;\n]*(?:err|error|e)\?*\.message/);
  assert.doesNotMatch(joined, /(?:textContent|innerHTML)\s*=\s*[^;\n]*(?:err|error|e)\?*\.message/);
});

test('web VOD classifies diagnostics but renders only closed editorial copy', () => {
  assert.match(watchPage, /const friendly = this\.getFriendlyPlaybackError\(safeMessage\)/);
  assert.doesNotMatch(watchPage, /watch-error-detail/);
  assert.doesNotMatch(
    watchPage,
    /showPlaybackError\(message[\s\S]*?<p class="watch-error[^"]*">\$\{(?:detail|safeMessage|message)\}/
  );
});
