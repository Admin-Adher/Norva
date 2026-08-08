const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cloudAccount = fs.readFileSync(
  path.resolve(__dirname, '..', 'public', 'cloud.html'),
  'utf8',
);

test('TV provider credentials never reuse Norva account autofill semantics', () => {
  assert.match(
    cloudAccount,
    /id="xtream-username"[^>]*autocomplete="off"[^>]*autocapitalize="none"[^>]*spellcheck="false"/i,
  );
  assert.match(
    cloudAccount,
    /id="xtream-password"[^>]*autocomplete="new-password"/i,
  );
  assert.doesNotMatch(
    cloudAccount,
    /id="xtream-username"[^>]*autocomplete="username"/i,
  );
  assert.doesNotMatch(
    cloudAccount,
    /id="xtream-password"[^>]*autocomplete="current-password"/i,
  );
});
