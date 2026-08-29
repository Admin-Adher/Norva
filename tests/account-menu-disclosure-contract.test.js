'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const app = read('public/js/app.js');
const profiles = read('public/js/profiles.js');
const css = read('public/css/main.css');
const { createDefaultNavigationModel } = require('../public/js/navigation/NavigationModel.js');

test('Web primary navigation keeps content visible and defers secondary actions to the avatar', () => {
  const model = createDefaultNavigationModel();
  assert.deepEqual(model.keysFor('web'), ['home', 'live', 'movies', 'series', 'downloads']);
  assert.doesNotMatch(
    model.renderProjection('web'),
    /data-page="settings"|data-page="admin"|data-action="logout"/,
  );
  assert.deepEqual(model.keysFor('tv'), ['home', 'live', 'movies', 'series', 'settings', 'logout']);
});

test('profile avatar exposes a real menu button on Web while TV keeps its direct switcher', () => {
  assert.match(profiles, /btn\.setAttribute\('aria-haspopup', 'menu'\)/);
  assert.match(profiles, /btn\.setAttribute\('aria-controls', 'account-menu-popover'\)/);
  assert.match(profiles, /btn\.setAttribute\('aria-expanded', 'false'\)/);
  assert.match(profiles, /new CustomEvent\('norva:account-menu-request'/);
  assert.match(profiles, /if \(isTv\)[\s\S]{0,100}openSwitcher\(\)/);
  assert.doesNotMatch(profiles, /Kids profile|Kids Profile/i);
});

test('desktop account disclosure is keyboard complete, fail-closed for Admin and restores focus', () => {
  assert.match(app, /id = 'account-menu-popover'/);
  assert.match(app, /role="menu" aria-label="Profile and account"/);
  assert.match(app, /data-act="settings" role="menuitem"/);
  assert.match(app, /data-act="admin" role="menuitem" hidden aria-hidden="true"/);
  assert.match(app, /data-act="help" role="menuitem"/);
  assert.match(app, /data-act="logout" role="menuitem"/);
  assert.match(app, /event\.key === 'Escape'/);
  assert.match(app, /\['ArrowDown', 'ArrowUp', 'Home', 'End'\]/);
  assert.match(app, /document\.addEventListener\('pointerdown', this\._accountMenuPointerDown, true\)/);
  assert.match(app, /this\.closeAccountMenu\(\{ restoreFocus: true \}\)/);
  assert.match(app, /row\.hidden = true[\s\S]{0,260}this\.checkIsAdmin\(\)/);
  assert.match(app, /if \(!row\.isConnected \|\| !allowed\) return/);
});

test('desktop popover and mobile sheet share the same secondary account actions', () => {
  for (const action of ['switch', 'manage', 'settings', 'admin', 'help', 'logout']) {
    assert.match(app, new RegExp(`data-act="${action}"`));
  }
  assert.match(app, /performAccountAction\(action, trigger = null\)/);
  assert.match(app, /window\.NorvaProfiles\?\.openManage\?\.\(\)/);
  assert.match(app, /window\.location\.href = '\/support\.html\?returnTo='/);
  assert.doesNotMatch(app, /Kids profile|Kids Profile/i);
});

test('profile switching stays discoverable for a single-profile cloud account', () => {
  assert.match(app, /if \(switchRow\) switchRow\.hidden = !cur\.isCloud/);
  assert.match(app, /if \(switchRow\) switchRow\.style\.display = cur\.isCloud \? '' : 'none'/);
  assert.doesNotMatch(app, /switchRow[^\n]+cur\.count > 1/);
});

test('account disclosure meets hit-target, hidden-state and reduced-motion contracts', () => {
  assert.match(css, /\.nav-profile\s*\{[\s\S]{0,220}width:\s*44px;[\s\S]{0,80}height:\s*44px;/);
  assert.match(css, /\.account-menu-item\s*\{[\s\S]{0,260}min-height:\s*52px;/);
  assert.match(css, /\.account-menu-popover\[hidden\]\s*\{\s*display:\s*none;/);
  assert.match(css, /\.account-menu-item\[hidden\]\s*\{\s*display:\s*none;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,120}animation:\s*none/);
});
