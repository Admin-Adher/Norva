'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const sourceHealth = read('public/js/utils/sourceHealth.js');
const sourceManager = read('public/js/components/SourceManager.js');
const home = read('public/js/pages/HomePage.js');
const app = read('public/js/app.js');
const css = read('public/css/main.css');
const shell = read('public/app.html');

test('one catalog policy drives Home, navigation and preparation state', () => {
  assert.match(sourceHealth, /function catalogSourcePolicy\(/);
  assert.match(sourceHealth, /function catalogAvailability\(/);
  assert.match(sourceHealth, /function isCatalogCategoryAvailable\(/);
  assert.match(home, /NorvaSourceHealth\?\.catalogAvailability\?\.\(summary\)/);
  assert.match(app, /NorvaSourceHealth\?\.isCatalogCategoryAvailable\?\.\(summary, category\)/);
  assert.match(sourceManager, /NorvaSourceHealth\?\.catalogSourcePolicy\?\.\(source\)/);
  assert.doesNotMatch(app, /Number\(counts\[category\]\) > 0/);
  assert.doesNotMatch(sourceManager, /counts\.total > 0\) return \{ phase: 'ready'/);
});

test('first-source form exposes field errors and focuses recovery', () => {
  assert.match(home, /aria-describedby="home-source-url-hint home-source-url-error"/);
  assert.match(home, /id="home-source-username-error"/);
  assert.match(home, /id="home-source-password-error"/);
  assert.match(home, /input\.setAttribute\('aria-invalid', 'true'\)/);
  assert.match(home, /firstInvalid\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(home, /manager\.buildSourceConnection\(/);
  assert.match(home, /manager\.confirmLargePlaylistIfNeeded\(payload\)/);
  assert.match(home, /submit\.setAttribute\('aria-busy', 'true'\)/);
});

test('catalog preparation modal shares focus, Back and inert hygiene', () => {
  assert.match(sourceManager, /NorvaModal\.installHygiene\(modal, \{[\s\S]{0,180}onClose: closeToSettings,[\s\S]{0,120}initialFocus: closeButton/);
  assert.match(sourceManager, /catalogErrorDetails\(/);
  assert.match(sourceManager, /actionLabel: 'Update login'/);
  assert.match(sourceManager, /actionLabel: 'Check again'/);
  assert.doesNotMatch(sourceManager, />Repair Login</);
});

test('onboarding controls remain operable in short and touch viewports', () => {
  assert.match(css, /#page-home\.home-setup-active\s*\{[\s\S]{0,140}overflow-y:\s*auto/);
  assert.match(css, /\.norva-setup-actions \.btn\s*\{[\s\S]{0,100}min-height:\s*44px/);
  assert.match(css, /\.setup-password-toggle\s*\{[\s\S]{0,260}width:\s*44px;[\s\S]{0,60}height:\s*44px/);
  assert.match(css, /\.modal-close\s*\{[\s\S]{0,120}min-width:\s*44px;[\s\S]{0,80}min-height:\s*44px/);
  assert.match(css, /\.modal-footer \.btn\s*\{[\s\S]{0,80}min-height:\s*44px/);
  assert.match(css, /@media \(max-width: 900px\), \(max-height: 620px\)[\s\S]{0,700}home-setup-connect-active[\s\S]{0,220}height:\s*auto/);
});

test('setup visuals reuse Norva assets and ship cache-busted', () => {
  assert.match(shell, /class="tc-intro-icon" src="\/img\/icons\/norva-live-tv\.svg/);
  assert.match(shell, /class="tc-intro-icon" src="\/img\/icons\/norva-movies\.svg/);
  assert.match(shell, /class="tc-intro-icon" src="\/img\/icons\/norva-settings\.svg/);
  assert.doesNotMatch(shell, /<div class="tc-intro-icon">/);
  assert.match(shell, /main\.css\?v=109/);
  assert.match(shell, /sourceHealth\.js\?v=10/);
  assert.match(shell, /SourceManager\.js\?v=42/);
  assert.match(shell, /HomePage\.js\?v=61/);
  assert.match(shell, /app\.js\?v=2c1d21d360/);
});
