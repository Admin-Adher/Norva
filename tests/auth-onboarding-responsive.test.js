'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

test('auth and pairing pages can scroll and keep 44px targets on phones', () => {
  const account = read('public/account.html');
  assert.match(account, /overflow-y:\s*auto/);
  assert.match(account, /\.tab \{[\s\S]{0,40}min-height:\s*44px/);
  assert.match(account, /\.ghost \{[\s\S]{0,80}min-height:\s*44px/);
  assert.match(account, /min-height:44px/);

  const paywall = read('public/paywall.html');
  assert.match(paywall, /overflow-y:\s*auto/);
  assert.match(paywall, /\.ecosystem-proof \{ grid-template-columns: 1fr;/);

  const pair = read('public/pair.html');
  assert.match(pair, /#pair-code \{[\s\S]{0,80}clamp\(1\.6rem/);
  assert.match(pair, /overflow-y:\s*auto/);

  const cloudPair = read('public/cloud-pair.html');
  assert.match(cloudPair, /\.code \{[\s\S]{0,200}clamp\(28px/);
  assert.match(cloudPair, /safe-area-inset-bottom/);

  const login = read('public/login.html');
  assert.match(login, /font-size:\s*16px/);
  assert.match(login, /min-height:\s*44px/);
});

test('native premium auth joins the card and stays touch-safe across phone viewports', () => {
  const css = read('public/css/account-premium.css');
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*html\.premium-auth\.native-app \.shell \{ gap: 0; margin-block: auto; \}/);
  assert.match(css, /\.shell \{[\s\S]{0,260}max-height: calc\(100dvh - 32px\);[\s\S]{0,180}overflow-y: auto;/);
  assert.match(css, /html\.premium-auth\.native-app \.fine a \{[\s\S]{0,160}min-height: 44px;/);
  assert.match(css, /html\.premium-auth\.native-app body \{[\s\S]{0,180}justify-content: center;[\s\S]{0,260}safe-area-inset-bottom/);
});
