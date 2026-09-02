'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n');

const appHtml = read('public/app.html');
const settings = read('public/js/pages/Settings.js');
const moduleSource = read('public/js/components/DevicesScreensModule.js');
const pairSheet = read('public/js/components/PairTvSheet.js');
const css = read('public/css/main.css');

test('prototype D ships as a deep Settings module, not inline page code', () => {
  const screensPanel = appHtml.slice(
    appHtml.indexOf('<!-- Screens & Pairing Tab -->'),
    appHtml.indexOf('<!-- Sources Tab -->'),
  );
  const pairIndex = appHtml.indexOf('/js/components/PairTvSheet.js?v=');
  const moduleIndex = appHtml.indexOf('/js/components/DevicesScreensModule.js?v=');
  const settingsIndex = appHtml.indexOf('/js/pages/Settings.js?v=');

  assert.match(screensPanel, /id="devices-screens-root" class="devices-screens-root"/);
  assert.doesNotMatch(screensPanel, /<style>|screens-wrap|screens-devices-list/);
  assert.ok(pairIndex > 0 && pairIndex < moduleIndex && moduleIndex < settingsIndex);
  assert.match(settings, /this\.devicesScreensModule = null/);
  assert.match(settings, /new Module\(this\.app, root\)/);
  assert.match(settings, /devicesScreensModule\.activate\(\)/);
  assert.match(settings, /devicesScreensModule\?\.deactivate\?\.\(\)/);
  assert.match(settings, /settings-screens-active/);
});

test('Norva Everywhere keeps the accepted cinematic, management and guided-install layers', () => {
  for (const copy of [
    /Norva everywhere/,
    /Every screen, one Norva\./,
    /Your screens/,
    /Watch elsewhere/,
    /Start on your TV/,
    /Pair a TV/,
    /Get the Android TV app/,
    /Watch at norva\.tv/,
    /Your account/,
  ]) assert.match(moduleSource, copy);

  assert.match(moduleSource, /https:\/\/play\.google\.com\/store\/apps\/details\?id=tv\.norva\.tv/);
  assert.match(moduleSource, /https:\/\/norva\.tv/);
  assert.match(moduleSource, /compatible TV signed in to the same Google account/);
  assert.match(css, /url\('\/assets\/landing\/norva-every-screen-premium\.webp'\)/);
  assert.ok(fs.existsSync(path.join(root, 'public/assets/landing/norva-every-screen-premium.webp')));
  assert.ok(fs.existsSync(path.join(root, 'public/img/icons/google-play-mark.svg')));

  assert.doesNotMatch(moduleSource, /Télécharg|Appareils|Écrans|Hors ligne|Réessayer|Supprimer|Modifier/);
});

test('loading, empty, connected, offline, error and concurrent-action states are closed', () => {
  assert.match(moduleSource, /renderLoading\(\)/);
  assert.match(moduleSource, /connected \? this\.devicesSection\(\) \+ this\.watchElsewhere\(\) : this\.setupSection\(\)/);
  assert.match(moduleSource, /navigator\.onLine === false/);
  assert.match(moduleSource, /data-devices-retry/);
  assert.match(moduleSource, /Promise\.allSettled/);
  assert.match(moduleSource, /requestEpoch/);
  assert.match(moduleSource, /pendingRevoke = new Set\(\)/);
  assert.match(moduleSource, /form\.dataset\.busy === '1'/);
  assert.match(moduleSource, /Could not remove this screen\. Try again\./);
  assert.match(moduleSource, /Could not reach this screen\./);
  assert.doesNotMatch(moduleSource, /(?:textContent|innerHTML)\s*=\s*[^;\n]*(?:error|err)\?*\.message/);
  assert.doesNotMatch(moduleSource, /JSON\.stringify\((?:error|err)/);
});

test('device management is compact, explicit and destructive actions require confirmation', () => {
  assert.match(moduleSource, /data-devices-menu/);
  assert.match(moduleSource, /role="menu"/);
  assert.match(moduleSource, /role="menuitem"/);
  assert.match(moduleSource, /Send a link/);
  assert.match(moduleSource, /Remove screen/);
  assert.match(moduleSource, /NorvaModal\?\.confirm/);
  assert.match(moduleSource, /cancelLabel: 'Keep screen'/);
  assert.match(moduleSource, /aria-busy/);
  assert.match(moduleSource, /aria-expanded="false"/);
  assert.match(moduleSource, /event\.key === 'Escape'/);
});

test('sheets and status changes keep focus, Back, safe-area and live-region contracts', () => {
  assert.match(moduleSource, /role="dialog" aria-modal="true"/);
  assert.match(moduleSource, /NorvaModal\?\.installHygiene/);
  assert.match(moduleSource, /initialFocus: focusTarget/);
  assert.match(moduleSource, /overlay\.setAttribute\('inert', ''\)/);
  assert.match(moduleSource, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(pairSheet, /norva:devices-changed/);
  assert.match(css, /\.devices-sheet[\s\S]{0,500}max-height: min\(90dvh, 760px\)/);
  assert.match(css, /\.devices-sheet[\s\S]{0,700}var\(--safe-area-inset-bottom\)/);
  assert.match(css, /\.devices-more[\s\S]{0,160}width: 44px;[\s\S]{0,80}height: 44px/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,220}animation: none/);
});

test('mobile mode replaces only the Devices rail and keeps one bounded scroll owner', () => {
  assert.match(css, /#page-settings\.settings-screens-active \.settings-container > \.settings-rail-title,[\s\S]{0,140}\.settings-container > \.tabs[\s\S]{0,80}display: none/);
  assert.match(css, /#page-settings\.settings-screens-active #tab-screens[\s\S]{0,320}overflow-y: auto/);
  assert.match(css, /#page-settings\.settings-screens-active #tab-screens[\s\S]{0,520}var\(--safe-area-inset-bottom\)/);
  assert.doesNotMatch(css.slice(css.indexOf('#page-settings.settings-screens-active #tab-screens'), css.indexOf('.devices-mobile-header', css.indexOf('#page-settings.settings-screens-active #tab-screens'))), /--bottom-nav-h/);
  assert.match(css, /@media \(min-width: 769px\)[\s\S]{0,180}body\.norva-phone-apk #page-settings\.settings-screens-active \.settings-container/);
});

test('device classification and readiness remain deterministic', () => {
  const window = {};
  vm.runInNewContext(moduleSource, { window, URL, Date, Promise, Set, String, Number, Boolean });
  const subject = Object.create(window.DevicesScreensModule.prototype);
  subject.currentDeviceId = () => 'phone-current';

  assert.equal(subject.deviceKind({ platform: 'Android TV' }), 'tv');
  assert.equal(subject.deviceKind({ platform: 'iPadOS' }), 'tablet');
  assert.equal(subject.deviceKind({ device_type: 'phone' }), 'phone');
  assert.equal(subject.deviceKind({ platform: 'Chrome browser' }), 'web');
  assert.equal(subject.deviceKind({ platform: 'unknown' }), 'screen');
  assert.equal(subject.deviceStatus({ id: 'phone-current' }, 10).label, 'Active on this device');

  const now = Date.now();
  assert.equal(subject.deviceStatus({ id: 'tv', last_seen_at: new Date(now - 60_000).toISOString() }, now).ready, true);
  assert.equal(subject.deviceStatus({ id: 'tv', last_seen_at: new Date(now - 600_000).toISOString() }, now).ready, false);
  assert.equal(subject.isSafeWebUrl('https://norva.tv/watch'), true);
  assert.equal(subject.isSafeWebUrl('javascript:alert(1)'), false);
});
