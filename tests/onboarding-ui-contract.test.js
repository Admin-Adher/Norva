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

test('finalize emits early live and first-slice browse unlocks', () => {
  const sourceSync = read('supabase/functions/norva-source-sync/index.ts');
  const cloud = read('supabase/functions/norva-cloud/index.ts');
  for (const source of [sourceSync, cloud]) {
    assert.match(source, /NORVA_BROWSE_TITLE_THRESHOLD/);
    assert.match(source, /browseReady: true/);
    assert.match(source, /liveReady: true/);
  }
  assert.match(sourceSync, /NORVA_FINALIZE_FIRST_SLICE_THROTTLE_MS/);
});

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
  assert.match(home, /aria-describedby="home-source-url-hint home-source-find-link home-source-url-error"/);
  assert.match(home, /Don’t have the link handy\?/);
  assert.match(home, /id="home-source-username-error"/);
  assert.match(home, /id="home-source-password-error"/);
  assert.match(home, /input\.setAttribute\('aria-invalid', 'true'\)/);
  assert.match(home, /firstInvalid\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(home, /manager\.buildSourceConnection\(/);
  assert.match(home, /manager\.confirmLargePlaylistIfNeeded\(payload\)/);
  assert.match(home, /submit\.setAttribute\('aria-busy', 'true'\)/);
  assert.match(home, /Paste your TV service link/);
  assert.match(home, />Connect</);
});

test('first-source provider fields cannot inherit Norva account autofill', () => {
  assert.match(home, /id="home-source-name"[^>]*name="provider-display-name"[^>]*autocomplete="off"/);
  assert.match(home, /id="home-source-username"[^>]*name="provider-login"[^>]*autocomplete="off"[^>]*autocapitalize="none"[^>]*spellcheck="false"/);
  assert.match(home, /id="home-source-password"[^>]*name="provider-secret"[^>]*autocomplete="new-password"/);
  assert.doesNotMatch(home, /id="home-source-username"[^>]*autocomplete="username"/);
  assert.doesNotMatch(home, /id="home-source-password"[^>]*autocomplete="current-password"/);
});

test('onboarding import uses a cinema-building surface instead of an ops dashboard', () => {
  assert.match(home, /Building your cinema/);
  assert.match(home, /renderSetupPosterStrip/);
  assert.match(home, /data-open-live/);
  assert.match(home, /home-import-ribbon/);
  assert.doesNotMatch(home, /Preparing your catalog/);
  assert.doesNotMatch(home, /Progress panel/);
});

test('an intentionally paused account gets a recovery surface instead of first-run onboarding', () => {
  const pausedStart = home.indexOf('renderPausedServicesGate(container, summary = {})');
  const pausedEnd = home.indexOf('renderSetupPosterStrip()', pausedStart);
  const pausedSurface = home.slice(pausedStart, pausedEnd);
  assert.ok(pausedStart > -1 && pausedEnd > pausedStart);
  assert.match(home, /state === 'disabled'[\s\S]{0,120}renderPausedServicesGate\(container, summary\)/);
  assert.match(pausedSurface, /All TV services are paused/);
  assert.match(pausedSurface, /Catalog preserved/);
  assert.match(pausedSurface, /Enable \$\{multiple \? 'a service' : 'service'\}/);
  assert.doesNotMatch(pausedSurface, /Norva setup|Check again|setupSteps/);
  assert.match(css, /\.norva-paused-home\s*\{[\s\S]{0,220}grid-template-columns:/);
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*\.norva-paused-home-actions \.btn\s*\{[\s\S]{0,80}width:\s*100%/);
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
  assert.match(css, /\.norva-setup-connect\s*\{[\s\S]{0,720}overflow-y:\s*auto/);
  assert.match(css, /\.setup-manual-grid\s*\{[\s\S]{0,80}grid-template-columns:\s*minmax\(0, 1fr\)/);
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
  assert.match(shell, /main\.css\?v=ee4d1292b9/);
  assert.match(shell, /sourceHealth\.js\?v=6c0eefcb4f/);
  assert.match(shell, /SourceManager\.js\?v=dedefaf3cf/);
  assert.match(shell, /HomePage\.js\?v=6016cf63fb/);
  assert.match(shell, /app\.js\?v=877ca37de9/);
});
