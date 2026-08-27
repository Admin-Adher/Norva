const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cloudAccount = fs.readFileSync(
  path.resolve(__dirname, '..', 'public', 'cloud.html'),
  'utf8',
);
const mobilePwaCloudAccount = fs.readFileSync(
  path.resolve(__dirname, '..', 'clients', 'mobile-pwa', 'cloud.html'),
  'utf8',
);

test('TV provider credentials never reuse Norva account autofill semantics', () => {
  for (const surface of [cloudAccount, mobilePwaCloudAccount]) {
    assert.match(
      surface,
      /id="source-name"[^>]*name="provider-display-name"[^>]*autocomplete="off"/i,
    );
    assert.match(
      surface,
      /id="xtream-username"[^>]*name="provider-login"[^>]*autocomplete="off"[^>]*autocapitalize="none"[^>]*spellcheck="false"/i,
    );
    assert.match(
      surface,
      /id="xtream-password"[^>]*name="provider-secret"[^>]*autocomplete="new-password"/i,
    );
    assert.doesNotMatch(
      surface,
      /id="xtream-username"[^>]*autocomplete="username"/i,
    );
    assert.doesNotMatch(
      surface,
      /id="xtream-password"[^>]*autocomplete="current-password"/i,
    );
  }
});
