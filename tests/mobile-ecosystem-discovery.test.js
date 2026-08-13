const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

test('native sign-up leads with the real multi-device Norva promise', () => {
  const account = read('public/account.html');
  const firstSlide = account.slice(
    account.indexOf('<article class="onb-slide">'),
    account.indexOf('</article>', account.indexOf('<article class="onb-slide">')),
  );
  assert.match(firstSlide, /\/assets\/landing\/norva-multi-device\.svg/);
  assert.match(firstSlide, /Norva, everywhere you watch/);
  for (const device of ['Phone', 'tablet', 'web', 'Android TV']) {
    assert.match(firstSlide, new RegExp(device, 'i'));
  }
  assert.match(firstSlide, /profiles, favorites and playback progress/i);
});

test('phone Home reveals a dismissible ecosystem card only after a cloud catalog is ready', () => {
  const home = read('public/js/pages/HomePage.js');
  const method = home.slice(
    home.indexOf('renderEcosystemCard('),
    home.indexOf('\n    renderSetupGate(', home.indexOf('renderEcosystemCard(')),
  );
  assert.match(home, /id="home-ecosystem"/);
  assert.match(method, /NorvaTV-AndroidPhone/);
  assert.match(method, /isCloudMode/);
  assert.match(method, /isCatalogReady/);
  assert.match(method, /norva-ecosystem-card-dismissed-v1/);
  assert.match(method, /norva-multi-device\.svg/);
  assert.match(method, /play\.google\.com\/store\/apps\/details\?id=tv\.norva\.tv/);
  assert.match(method, /data-ecosystem-pair/);
  assert.match(method, /Enable notifications/);
});

test('phone Home opens the in-place Pair TV sheet instead of navigating to Settings', () => {
  const home = read('public/js/pages/HomePage.js');
  const delegatedClick = home.slice(
    home.indexOf("this.container.addEventListener('click'"),
    home.indexOf("this.container.addEventListener('keydown'"),
  );
  assert.match(delegatedClick, /openPairTvSheet/);
  assert.doesNotMatch(delegatedClick, /openScreensSettings/);
});

test('devices and pairing are permanent cloud-account destinations, not an Advanced tab', () => {
  const appHtml = read('public/app.html');
  const appJs = read('public/js/app.js');
  assert.match(appHtml, /class="tab" data-tab="screens" id="screens-tab"[^>]*>[\s\S]*?<span>Devices<\/span>[\s\S]*?<\/button>/);
  assert.doesNotMatch(appHtml, /class="tab tab-advanced" data-tab="screens"/);
  assert.match(appHtml, /Add a TV, phone, tablet or browser/);
  assert.match(appHtml, /Your devices &amp; screens/);
  assert.match(appJs, /data-act="screens"/);
  assert.match(appJs, /Web, phone, tablet and TV/);
  assert.match(appJs, /openScreensSettings\(\)/);
});

test('Android notification permission is requested only from the contextual Home action', () => {
  const native = read('clients/android-phone/app/src/main/java/tv/norva/phone/MainActivity.java');
  const setup = native.slice(
    native.indexOf('private void setupPush()'),
    native.indexOf('\n    private ', native.indexOf('private void setupPush()') + 10),
  );
  assert.doesNotMatch(setup, /ensureNotifPermission\(\)/);
  assert.match(native, /public String notificationPermissionState\(\)/);
  assert.match(native, /public void requestNotificationPermission\(\)/);
  assert.match(native, /notificationPermissionAsked/);
  assert.match(native, /shouldShowRequestPermissionRationale\(Manifest\.permission\.POST_NOTIFICATIONS\)/);
  assert.match(native, /notificationPermissionMigrationV18/);
  assert.match(native, /lastUpdateTime > info\.firstInstallTime/);
  assert.match(native, /norva:notification-permission-changed/);
});

test('transaction and win-back surfaces show the multi-device proof and name tablets', () => {
  for (const file of [
    'public/paywall.html',
    'public/subscribe.html',
    'public/checkout-revolut.html',
  ]) {
    const source = read(file);
    assert.match(source, /\/assets\/landing\/norva-multi-device\.svg/, file);
    assert.match(source, /Android mobile \(phone and tablet\)[\s\S]{0,60}Android TV/i, file);
  }

  const subscription = read('public/subscription.html');
  assert.match(subscription, /\/img\/subscription\/norva-subscription-devices\.png/);
  assert.match(subscription, /Android mobile \(phone and tablet\)[\s\S]{0,60}Android TV/i);
  assert.ok(
    fs.existsSync(path.join(root, 'public/img/subscription/norva-subscription-devices.png')),
    'the subscription-specific multi-device artwork must ship with the page',
  );
});
